/**
 * Funds Agama's role accounts with QOR from the treasury, in one hybrid-signed native transaction.
 *
 *   tsx src/fund.ts <operator> <reporter> <compliance> <attester> <auditor>     QOR for each, 0 to skip
 */
import { ROLES, account } from "./accounts.js";
import { treasuryClient } from "./native.js";

const amounts = process.argv.slice(2).map(Number);
const { client, address } = await treasuryClient();
const msgs = [];
for (let i = 0; i < ROLES.length; i++) {
  const qor = amounts[i] ?? 0;
  if (!qor) continue;
  const to = (await account(ROLES[i])).cosmos;
  msgs.push({
    typeUrl: "/cosmos.bank.v1beta1.MsgSend",
    value: { fromAddress: address, toAddress: to, amount: [{ denom: "uqor", amount: String(Math.round(qor * 1e6)) }] },
  });
  console.log(`${ROLES[i]}: ${qor} QOR -> ${to}`);
}
if (!msgs.length) throw new Error("nothing to send");
const res = await client.signAndBroadcast(msgs, "auto", "agama: fund role accounts");
console.log("tx", (res as any).transactionHash ?? res);
