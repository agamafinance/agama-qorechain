/**
 * Prepares the browser e2e lender: account index 1 of the funding mnemonic, the account the QoreX test double signs
 * with in web/e2e. Sends it QOR and registers its canonical ML-DSA-87 key, the one QoreX would derive.
 *
 *   tsx src/lender.ts [qor] [index]
 */
import { treasury } from "./accounts.js";
import { treasuryClient } from "./native.js";

const qor = Number(process.argv[2] ?? 8);
const index = Number(process.argv[3] ?? 1);
const lender = (await treasury(index)).native.address;
const { client, address } = await treasuryClient(0);
const res: any = await client.signAndBroadcast(
  [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: address, toAddress: lender, amount: [{ denom: "uqor", amount: String(qor * 1e6) }] } }],
  "auto",
  "agama: fund the browser e2e lender",
);
console.log(`${qor} QOR -> ${lender}: ${res.transactionHash}`);
await new Promise((r) => setTimeout(r, 4_000));
await treasuryClient(index); // registers the canonical ML-DSA-87 key on first use
console.log(`${lender}: ML-DSA-87 key registered`);
