/**
 * A battery on PqAccounts, with real transactions on qorechain-diana and the running keeper as compliance officer.
 * Four brand-new QoreX-style lenders (coin 118, indexes PQ_BASE.. of the funding mnemonic) that hold an ML-DSA-87
 * key and nothing else. Each signs messages exactly as QoreX does (ADR-36 + ML-DSA-87) and never sends a
 * transaction of its own:
 *
 *   A  professional, FR     approved: deposit, instant withdrawal, queued withdrawal, queue settled
 *   B  institutional, DE    approved: deposit, full withdrawal
 *   C  retail, FR           rejected: a deposit is refused
 *   D  professional, US     rejected: a deposit is refused
 *
 * Each opens its own sealed decision letter; the officer's letter must show it verified the PqAccount filing. At the
 * end no lender has an EVM window, an authz grant, or a single uqor less than after its key was registered.
 *
 *   tsx src/pq-battery.ts            (PQ_BASE, default 20)
 */
import { fromBech32 } from "@cosmjs/encoding";
import { encodeFunctionData, hexToBytes, maxUint256, parseAbiItem, toHex, type Address, type Hex } from "viem";
import { generateSealKeys, open, seal, type SealKeyPair } from "@qorechain/qoreseal";
import { deriveCanonicalPqKey, deriveClassicalKey, signMessage } from "@qorechain/qoresign";
import { fetchEvmWindow } from "@qorechain/qoresign/network";
import { account, funderMnemonic, treasury } from "./accounts.js";
import { Q } from "./config.js";
import { artifact } from "./evm.js";
import { qorBalance, sendNative, treasuryClient } from "./native.js";
import { REST, qore, rest, sleep } from "./net.js";
import { accountOf, nonceOf, submit, textFor, type Call } from "./pqaccounts.js";
import { ensureRelayer } from "./relayer.js";
import { aadFor, officer, SEAL } from "./sealing.js";

const BASE = Number(process.env.PQ_BASE ?? 20);
const m = funderMnemonic();
const A = { usdc: artifact("MockUSDC").abi, vault: artifact("AgUSD").abi, access: artifact("AccessRegistry").abi };
const read = <T>(address: Address, abi: any, fn: string, args: unknown[] = []) => qore.readContract({ address, abi, functionName: fn, args }) as Promise<T>;
const call = (target: Address, abi: any, fn: string, args: unknown[] = []): Call => ({ target, data: encodeFunctionData({ abi, functionName: fn, args }) });

let ok = 0, n = 0;
const check = (label: string, c: boolean, detail = "") => (n++, c && ok++, console.log(`${c ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`));
const refused = async (fn: () => Promise<unknown>) => { try { await fn(); return false; } catch { return true; } };

type Lender = { tag: string; i: number; qor1: string; owner: Address; acc: Address; keys: SealKeyPair; profile: Record<string, unknown>; approve: boolean; qorAfterKey?: bigint };
const PROFILES = [
  { tag: "A", name: "Amélie Laurent", country: "FR", investorType: "professional", approve: true },
  { tag: "B", name: "Bergmann Treuhand GmbH", country: "DE", investorType: "institutional", approve: true },
  { tag: "C", name: "Chloé Martin", country: "FR", investorType: "retail", approve: false },
  { tag: "D", name: "Dylan Brooks", country: "US", investorType: "professional", approve: false },
];

async function act(l: Lender, calls: Call[], summary: string) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const text = textFor(l.acc, calls, summary, await nonceOf(l.acc), deadline);
  const signature = signMessage({ chainId: "qorechain-diana", signer: l.qor1, data: text, classicalKey: deriveClassicalKey({ mnemonic: m, index: l.i }), pqKey: deriveCanonicalPqKey({ mnemonic: m, address: l.qor1 } as any) }) as any;
  return submit({ owner: l.owner, calls, summary, deadline: String(deadline), signature });
}

await ensureRelayer();
console.log("1. four new QoreX accounts: an ML-DSA-87 key each, nothing else");
const lenders: Lender[] = [];
for (const [k, p] of PROFILES.entries()) {
  const i = BASE + k;
  const qor1 = (await treasury(i)).native.address;
  if ((await qorBalance(qor1)) < 300_000n) {
    await sendNative("operator", [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: (await account("operator")).cosmos, toAddress: qor1, amount: [{ denom: "uqor", amount: "1000000" }] } }], "hybrid", 250_000);
    await sleep(6_000);
  }
  await treasuryClient(i); // what QoreX does with an account's first transaction: register its ML-DSA-87 key
  const owner = toHex(fromBech32(qor1, 90).data) as Address;
  const l: Lender = { tag: p.tag, i, qor1, owner, acc: await accountOf(owner), keys: generateSealKeys(), approve: p.approve,
    profile: { v: 1, name: p.name, country: p.country, investorType: p.investorType, attestations: { notUsPerson: p.country !== "US", notSanctioned: true, understandsRisk: true }, declaredAt: new Date().toISOString() } };
  await sleep(2_000);
  l.qorAfterKey = await qorBalance(qor1);
  lenders.push(l);
  console.log(`   ${p.tag} ${qor1} -> PqAccount ${l.acc}`);
}

console.log("\n2. test USDC, encryption key and sealed application: three signed messages each");
for (const l of lenders) {
  await act(l, [call(Q.usdc, A.usdc, "faucet")], "Get 10,000 test USDC");
  await act(l, [call(Q.access, A.access, "publishEncryptionKey", [toHex(l.keys.mlkemPublicKey)])], "Publish your encryption key");
  const envelope = toHex(seal({ chainId: SEAL.chainId, purpose: SEAL.dossier, mode: SEAL.mode, aad: aadFor(l.acc), recipients: [await officer("compliance"), await officer("auditor")], plaintext: new TextEncoder().encode(JSON.stringify(l.profile)) }));
  const r = await act(l, [call(Q.access, A.access, "fileDossier", [envelope])], "File your sealed application");
  const code = await qore.getCode({ address: l.acc });
  check(`${l.tag}: PqAccount created by its first message, application filed`, !!code && code !== "0x" && (await read<bigint>(Q.usdc, A.usdc, "balanceOf", [l.acc])) >= 10_000_000_000n, `${(envelope.length - 2) / 2} bytes sealed, ${r.txHash.slice(0, 12)}…`);
}

console.log("\n3. the running keeper decides (ML-DSA-87 signed, checked on chain)");
const deadlineAt = Date.now() + 8 * 60_000;
for (const l of lenders) {
  let st = 1;
  while (Date.now() < deadlineAt) {
    st = Number((await read<readonly unknown[]>(Q.access, A.access, "members", [l.acc]))[0]);
    if (st !== 1) break;
    await sleep(10_000);
  }
  check(`${l.tag}: ${l.approve ? "approved" : "rejected"}`, st === (l.approve ? 2 : 3), ["None", "Pending", "Approved", "Rejected", "Revoked"][st]);
  const ev = parseAbiItem(l.approve
    ? "event Approved(address indexed account, uint8 tier, uint64 expiresAt, bytes32 dossierHash, bytes letter)"
    : "event Rejected(address indexed account, bytes32 dossierHash, bytes letter)");
  const head = await qore.getBlockNumber();
  const logs = await qore.getLogs({ address: Q.access, event: ev as any, args: { account: l.acc } as any, fromBlock: head - 3_000n, toBlock: head });
  try {
    const letter = JSON.parse(new TextDecoder().decode(open({ chainId: SEAL.chainId, purpose: SEAL.letter, envelope: hexToBytes((logs.at(-1) as any).args.letter as Hex), keys: l.keys, aad: aadFor(l.acc) })));
    check(`${l.tag}: opens its own sealed letter; the officer verified the PqAccount filing`, letter.provenance?.lane === "pq-account" && letter.provenance.postQuantum === true, l.approve ? letter.tierName : letter.reasons?.[0]);
  } catch (e: any) {
    check(`${l.tag}: opens its own sealed letter`, false, String(e?.message ?? e).slice(0, 80));
  }
}

console.log("\n4. money in and out, one signed message per action");
for (const l of lenders) {
  if (!l.approve) {
    check(`${l.tag}: a deposit by a rejected lender is refused`, await refused(() => act(l, [call(Q.usdc, A.usdc, "approve", [Q.vault, maxUint256]), call(Q.vault, A.vault, "deposit", [1_000_000_000n, l.acc])], "Deposit 1,000 USDC")));
    continue;
  }
  const amount = 3_000_000_000n;
  await act(l, [call(Q.usdc, A.usdc, "approve", [Q.vault, maxUint256]), call(Q.vault, A.vault, "deposit", [amount, l.acc])], "Deposit 3,000 USDC");
  const shares = await read<bigint>(Q.vault, A.vault, "balanceOf", [l.acc]);
  check(`${l.tag}: deposit, approval and deposit in one message`, shares > 0n, `${Number(shares) / 1e6} agUSD`);
  if (l.tag === "A") {
    const usdc0 = await read<bigint>(Q.usdc, A.usdc, "balanceOf", [l.acc]);
    await act(l, [call(Q.vault, A.vault, "redeem", [shares / 5n, l.acc, l.acc])], "Withdraw instantly");
    check("A: instant withdrawal from the buffer", (await read<bigint>(Q.usdc, A.usdc, "balanceOf", [l.acc])) > usdc0);
    const q = (await read<bigint>(Q.vault, A.vault, "balanceOf", [l.acc])) / 4n;
    const usdc1 = await read<bigint>(Q.usdc, A.usdc, "balanceOf", [l.acc]);
    await act(l, [call(Q.vault, A.vault, "requestRedeem", [q, l.acc, l.acc])], "Queue a withdrawal");
    const reqs = await read<readonly bigint[]>(Q.vault, A.vault, "requestsOf", [l.acc]);
    const id = reqs.at(-1)!;
    check("A: queued withdrawal recorded, priced at the request", reqs.length > 0 && (await read<bigint>(Q.vault, A.vault, "balanceOf", [l.acc])) < q * 4n, `request #${id}`);
    // The vault pays queued requests in order as soon as the buffer covers them (on request, or when anyone pushes).
    await act(l, [call(Q.vault, A.vault, "settleRedemptions", [16n])], "Push the queue");
    const next = await read<bigint>(Q.vault, A.vault, "nextToSettle");
    check("A: the queue is settled from the buffer, paid to the PqAccount", next > id && (await read<bigint>(Q.usdc, A.usdc, "balanceOf", [l.acc])) > usdc1, `next to settle #${next}`);
  } else {
    await act(l, [call(Q.vault, A.vault, "redeem", [shares, l.acc, l.acc])], "Withdraw everything");
    check(`${l.tag}: full withdrawal`, (await read<bigint>(Q.vault, A.vault, "balanceOf", [l.acc])) === 0n);
  }
}
const outsider = lenders.find((l) => !l.approve)!;
const approved = lenders.find((l) => l.approve)!;
check("agUSD cannot be sent to a rejected lender's PqAccount", await refused(() => act(approved, [call(Q.vault, A.vault, "transfer", [outsider.acc, 1n])], "Send 1 agUSD")));
check("a PqAccount cannot be told to call anything but Agama's contracts", await refused(() => act(approved, [{ target: Q.messenger, data: "0x" }], "Call the messenger")));

console.log("\n5. what the lenders never had to do");
for (const l of lenders) {
  const w: any = await fetchEvmWindow({ rest: REST, address: l.qor1 }).catch(() => null);
  const grants = await rest<any>(`/cosmos/authz/v1beta1/grants/granter/${l.qor1}`).catch(() => ({ grants: [] }));
  const qor = await qorBalance(l.qor1);
  check(`${l.tag}: no EVM window, no grant, no QOR spent`, !w?.live && (grants.grants ?? []).length === 0 && qor === l.qorAfterKey, `${Number(qor) / 1e6} QOR`);
}
console.log(`\n${ok}/${n} PqAccount battery checks passed`);
process.exit(ok === n ? 0 : 1);
