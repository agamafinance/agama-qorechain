/**
 * A brand-new QoreX account, as a judge's would be after its first transaction: 1 QOR from the operator, then its
 * ML-DSA-87 key registered with proof of possession (what QoreX does with an account's first transaction). Nothing
 * else: no EVM window, no grant, no application. The browser onboarding test starts from there.
 *
 *   tsx src/new-lender.ts <index>      an index of the funding mnemonic (coin 118)
 */
import { fromBech32 } from "@cosmjs/encoding";
import { toHex, type Address } from "viem";
import { account, treasury } from "./accounts.js";
import { qorBalance, sendNative, treasuryClient } from "./native.js";
import { qore, sleep } from "./net.js";

const index = Number(process.argv[2]);
if (!Number.isInteger(index) || index < 1) throw new Error("usage: tsx src/new-lender.ts <index>");
const qor1 = (await treasury(index)).native.address;
if ((await qorBalance(qor1)) < 300_000n) {
  const op = await account("operator");
  await sendNative("operator", [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: op.cosmos, toAddress: qor1, amount: [{ denom: "uqor", amount: "1000000" }] } }], "hybrid", 250_000, `agama new lender ${index}`);
  for (let i = 0; i < 20 && (await qorBalance(qor1)) === 0n; i++) await sleep(1_500);
}
await treasuryClient(index);
const [registered, , , proven] = (await qore.readContract({
  address: "0x0000000000000000000000000000000000000a02",
  abi: [{ type: "function", name: "pqcKeyStatus", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }, { type: "uint8" }, { type: "bytes" }, { type: "bool" }] }],
  functionName: "pqcKeyStatus",
  args: [toHex(fromBech32(qor1, 90).data) as Address],
})) as readonly [boolean, number, string, boolean];
console.log(`${registered && proven ? "PASS" : "FAIL"}  lender ${index} ${qor1}: ML-DSA-87 key ${registered ? (proven ? "registered with proof of possession" : "registered, not proven") : "not registered"}`);
process.exit(registered && proven ? 0 : 1);
