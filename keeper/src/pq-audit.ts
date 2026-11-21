/**
 * Agama on QoreChain is post-quantum end to end. Two checks:
 *
 *  1. Every transaction each of Agama's accounts sent since a date carries a hybrid signature the chain verified
 *     (pqc_hybrid_verify status=verified, ML-DSA-87). An EVM transaction (ECDSA alone, the explorer's "not
 *     quantum-safe") is listed. The expected exception is a contract creation (a cross-VM call cannot create one),
 *     deployment only: none since the switch.
 *  2. No role has an EVM window, and an ECDSA-only EVM transaction from a role is refused by the chain.
 *
 *   tsx src/pq-audit.ts [since=2026-11-21T09:45:00Z]
 */
import { fetchEvmWindow } from "@qorechain/sdk";
import { account, ROLES, type Role } from "./accounts.js";
import { Q } from "./config.js";
import { artifact, wallet } from "./evm.js";
import { REST, rest } from "./net.js";

export const SWITCH = "2026-11-21T09:45:00Z";

async function txsOf(sender: string, since: number) {
  const out: any[] = [];
  for (let page = 1; page <= 30; page++) {
    const qs = new URLSearchParams({ query: `message.sender='${sender}'`, order_by: "ORDER_BY_DESC", "pagination.limit": "100", page: String(page) });
    const r = await rest<any>(`/cosmos/tx/v1beta1/txs?${qs}`);
    const txs: any[] = r.tx_responses ?? [];
    out.push(...txs.filter((t) => Date.parse(t.timestamp) >= since));
    if (txs.length < 100 || txs.some((t) => Date.parse(t.timestamp) < since)) break;
  }
  return out;
}

/** Part 1: every committed transaction of every role since `since`. */
export async function auditTransactions(since = Date.parse(SWITCH)) {
  let bad = 0;
  let total = 0;
  const lines: string[] = [];
  for (const role of ROLES) {
    const a = await account(role);
    const txs = (await txsOf(a.cosmos, since)).filter((t) => t.code === 0);
    const kinds = new Map<string, number>();
    const notHybrid: string[] = [];
    for (const t of txs) {
      const type = (t.tx.body.messages as any[]).map((m) => m["@type"].split(".").at(-1)).join("+");
      kinds.set(type, (kinds.get(type) ?? 0) + 1);
      const hybrid = t.events.some((e: any) => e.type === "pqc_hybrid_verify" && e.attributes.some((x: any) => x.key === "status" && x.value === "verified"));
      if (!hybrid) notHybrid.push(`${t.txhash} ${type} ${t.timestamp}`);
    }
    total += txs.length;
    bad += notHybrid.length;
    lines.push(`${role.padEnd(10)} ${String(txs.length).padStart(4)} txs, ${txs.length - notHybrid.length} hybrid-verified  [${[...kinds].map(([k, n]) => `${k} x${n}`).join(", ") || "none"}]`);
    for (const x of notHybrid) lines.push(`  NOT HYBRID ${x}`);
  }
  return { total, bad, lines };
}

/** Part 2: no window anywhere, and the chain refuses an ECDSA-only EVM transaction from a role. */
export async function ecdsaRefused(roles: Role[] = ["operator", "relayer"]) {
  const out: { role: Role; window: boolean; refused: boolean; reason: string }[] = [];
  for (const role of roles) {
    const a = await account(role);
    const w: any = await fetchEvmWindow({ rest: REST, address: a.cosmos } as any).catch(() => null);
    const wc = await wallet(role, "qorechain");
    let reason = "";
    let refused = false;
    try {
      // A harmless call (test USDC to the role itself), with a fixed gas limit so the node's estimate cannot be the
      // one refusing: the transaction itself is submitted.
      const hash = await wc.writeContract({ address: Q.usdc, abi: artifact("MockUSDC").abi, functionName: "faucet", args: [], account: wc.account!, chain: wc.chain, gas: 200_000n } as any);
      reason = `ACCEPTED ${hash}`;
    } catch (e: any) {
      reason = String(e?.details ?? e?.shortMessage ?? e?.message ?? e).split("\n")[0];
      refused = /no open EVM authori[sz]ation window/i.test(String(e?.message ?? "") + String(e?.details ?? ""));
    }
    out.push({ role, window: !!w?.live, refused, reason });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const since = Date.parse(process.argv[2] ?? SWITCH);
  const a = await auditTransactions(since);
  for (const l of a.lines) console.log(l);
  console.log(`\n${a.total - a.bad}/${a.total} transactions of Agama's accounts since ${new Date(since).toISOString()} carry a hybrid signature the chain verified`);
  const windows = await Promise.all(ROLES.map(async (r) => [r, (await fetchEvmWindow({ rest: REST, address: (await account(r)).cosmos } as any).catch(() => null)) as any] as const));
  console.log(`EVM windows open: ${windows.filter(([, w]) => w?.live).map(([r]) => r).join(", ") || "none"}`);
  const r = await ecdsaRefused();
  for (const x of r) console.log(`${x.refused ? "REFUSED" : "NOT REFUSED"}  ECDSA-only EVM tx from ${x.role}: ${x.reason}`);
  const ok = a.bad === 0 && windows.every(([, w]) => !w?.live) && r.every((x) => x.refused);
  console.log(ok ? "\nPASS: post-quantum end to end" : "\nFAIL");
  process.exit(ok ? 0 : 1);
}
