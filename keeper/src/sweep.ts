/**
 * Sends what test lenders have left in QOR back to the operator, so a battery costs what it burned in fees and no
 * more. Each lender signs its own transfer, hybrid.
 *
 *   tsx src/sweep.ts <from index> <to index>
 */
import { account, treasury } from "./accounts.js";
import { treasuryClient } from "./native.js";
import { REST } from "./net.js";

const [from, to] = process.argv.slice(2).map(Number);
const op = (await account("operator")).cosmos;
let total = 0n;
for (let i = from; i <= to; i++) {
  const addr = (await treasury(i)).native.address;
  const r = (await (await fetch(`${REST}/cosmos/bank/v1beta1/spendable_balances/${addr}/by_denom?denom=uqor`, { headers: { "user-agent": "curl/8.7.1" } })).json()) as any;
  const bal = BigInt(r.balance?.amount ?? "0");
  const keep = 60_000n; // the fee of this transfer
  if (bal <= keep + 100_000n) continue;
  try {
    const { client } = await treasuryClient(i);
    const res: any = await client.signAndBroadcast(
      [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: addr, toAddress: op, amount: [{ denom: "uqor", amount: String(bal - keep) }] } }],
      { amount: [{ denom: "uqor", amount: "50000" }], gas: "400000" },
      "agama: sweep test lender QOR back to the operator",
    );
    if (!res.code) total += bal - keep;
    console.log(`  #${i} ${addr}: ${Number(bal - keep) / 1e6} QOR back ${res.code ? `FAILED ${res.rawLog}` : ""}`);
  } catch (e) {
    console.log(`  #${i}: ${(e as Error).message.split("\n")[0]}`);
  }
}
console.log(`swept ${Number(total) / 1e6} QOR to the operator`);
