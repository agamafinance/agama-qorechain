/**
 * How long Agama runs on its own. For each account that pays gas: its balance, the fees it paid over the last days,
 * and the runway at that pace; the gas tank's rule and expiry; the operator's Sepolia ETH at today's gas price.
 * Fees only: transfers between Agama's own accounts (the relayer top-up, test funding) move QOR, they do not burn it.
 *
 *   tsx src/health.ts [days=3]      exits 1 when a runway is under 14 days or the gas tank expires within 7
 */
import { fetchAuthenticators, fetchSpendingRules } from "@qorechain/sdk";
import { formatEther, type Address } from "viem";
import { account, type Role } from "./accounts.js";
import { agentKey, treasuryAddress } from "./gastank.js";
import { qorBalance } from "./native.js";
import { eth, REST, rest } from "./net.js";

const DAYS = Number(process.argv[2] ?? 3);
const since = Date.now() - DAYS * 86_400_000;
const qor = (u: bigint | number) => (Number(u) / 1e6).toFixed(1);

async function feesSince(sender: string) {
  let fees = 0n;
  let txs = 0;
  for (let page = 1; page <= 30; page++) {
    const qs = new URLSearchParams({ query: `message.sender='${sender}'`, order_by: "ORDER_BY_DESC", "pagination.limit": "100", page: String(page) });
    const r = await rest<any>(`/cosmos/tx/v1beta1/txs?${qs}`);
    const list: any[] = r.tx_responses ?? [];
    for (const t of list) {
      if (Date.parse(t.timestamp) < since) continue;
      txs++;
      for (const c of t.tx?.auth_info?.fee?.amount ?? []) if (c.denom === "uqor") fees += BigInt(c.amount);
    }
    if (list.length < 100 || list.some((t) => Date.parse(t.timestamp) < since)) break;
  }
  return { fees, txs };
}

const warnings: string[] = [];
console.log(`Agama on QoreChain: runway at the pace of the last ${DAYS} days\n`);

for (const role of ["operator", "relayer"] as Role[]) {
  const a = await account(role);
  const [balance, { fees, txs }] = await Promise.all([qorBalance(a.cosmos), feesSince(a.cosmos)]);
  const perDay = Number(fees) / DAYS;
  const runway = perDay > 0 ? Number(balance) / perDay : Infinity;
  console.log(`${role.padEnd(9)} ${qor(balance).padStart(7)} QOR   ${String(txs).padStart(4)} txs, ${qor(perDay)} QOR of fees a day   runway ${Number.isFinite(runway) ? `${Math.floor(runway)} days` : "unlimited"}`);
  if (runway < 14) warnings.push(`${role} runway under 14 days`);
}

const owner = await treasuryAddress();
const pk = Buffer.from(agentKey().pk).toString("hex");
const [tankBalance, rules, auths] = await Promise.all([
  qorBalance(owner),
  fetchSpendingRules({ rest: REST, address: owner }),
  fetchAuthenticators({ rest: REST, address: owner }),
]);
const me = (auths as any[]).find((x) => x.pubkeyHex.toLowerCase() === pk);
const rule = (rules as any).rules.find((x: any) => x.id === "agama-gas");
const daysLeft = me ? Math.floor((Number(me.expiryUnix) * 1000 - Date.now()) / 86_400_000) : -1;
console.log(
  `gas tank  ${qor(tankBalance).padStart(7)} QOR   rule ${rule ? `${qor(BigInt(rule.perTxLimit))} per payment, ${qor(BigInt(rule.dailyLimit))} a day` : "missing"}   ` +
    (me ? `${me.revoked ? "REVOKED" : "linked"}, expires ${new Date(Number(me.expiryUnix) * 1000).toISOString().slice(0, 10)} (${daysLeft} days)` : "keeper key not linked"),
);
if (!me || me.revoked) warnings.push("gas tank not linked");
else if (daysLeft < 7) warnings.push("gas tank expires within 7 days: tsx src/gastank.ts link");

const op = (await account("operator")).evm as Address;
const [wei, gasPrice] = await Promise.all([eth.getBalance({ address: op }), eth.getGasPrice()]);
// A bridge round trip on Sepolia (mint, settle, report) costs about 850k gas.
const legs = gasPrice > 0n ? wei / (gasPrice * 850_000n) : 0n;
console.log(`sepolia   ${Number(formatEther(wei)).toFixed(4).padStart(7)} ETH   gas ${(Number(gasPrice) / 1e9).toPrecision(2)} gwei, about ${legs > 1_000_000n ? "over a million" : legs} bridge legs`);
if (legs < 20n) warnings.push("Sepolia ETH low for the bridge");

console.log(warnings.length ? `\nWARN  ${warnings.join("; ")}` : "\nOK  every runway over 14 days, gas tank linked");
process.exit(warnings.length ? 1 : 0);
