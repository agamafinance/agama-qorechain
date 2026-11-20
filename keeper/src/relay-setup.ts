/**
 * Puts a QoreX-style (coin 118) account of the funding mnemonic where a lender is after Agama's setup, for tests:
 * QOR for its own fees, its canonical ML-DSA-87 key registered (what QoreX does), and an EVM access window (what
 * QoreX's "EVM access window" screen opens). With --grant it also signs the authz grant the app asks for.
 * Does nothing that is already in place.
 *
 *   tsx src/relay-setup.ts <index> [--grant]
 */
import { openEvmWindowMsg } from "@qorechain/sdk";
import { evmWindowCost } from "@qorechain/evm";
import { account, treasury } from "./accounts.js";
import { Q } from "./config.js";
import { qorBalance, sendNative, treasuryClient } from "./native.js";
import { status } from "./relayer.js";

const index = Number(process.argv[2] ?? 7);
const lender = (await treasury(index)).native.address;
console.log(`lender #${index}: ${lender}`);
if ((await qorBalance(lender)) < 1_500_000n) {
  const op = (await account("operator")).cosmos;
  const tx = await sendNative("operator", [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: op, toAddress: lender, amount: [{ denom: "uqor", amount: "3000000" }] } }], "hybrid", 250_000);
  console.log(`  3 QOR ${tx}`);
  await new Promise((r) => setTimeout(r, 6_000));
}
const { client } = await treasuryClient(index); // registers the canonical ML-DSA-87 key on first use
let st = await status(lender);
if (!st.window.live || Number(st.window.remainingBlocks) < 600) {
  const maxTxs = 200n;
  const maxValue = evmWindowCost({ gas: 6_000_000n, maxFeePerGas: 250_000_000_000n }) * maxTxs;
  const r: any = await client.signAndBroadcast([openEvmWindowMsg({ sender: lender, blocks: 17_000n, maxTxs, maxValue, allowedTargets: [Q.usdc, Q.access, Q.vault] } as any)], "auto", "EVM access window for Agama");
  if (r.code) throw new Error(`window: ${r.rawLog}`);
  console.log(`  EVM window ${r.transactionHash}`);
}
if (process.argv.includes("--grant") && !st.grant) {
  const msg = Buffer.from("/qorechain.crossvm.v1.MsgCrossVMCall");
  const r: any = await client.signAndBroadcast([{
    typeUrl: "/cosmos.authz.v1beta1.MsgGrant",
    value: { granter: lender, grantee: st.relayer, grant: { authorization: { typeUrl: "/cosmos.authz.v1beta1.GenericAuthorization", value: Uint8Array.from([0x0a, msg.length, ...msg]) }, expiration: { seconds: BigInt(Math.floor(Date.now() / 1000) + 7 * 86400), nanos: 0 } } },
  }], "auto", "Agama: let the relayer execute the actions you sign, for 7 days");
  if (r.code) throw new Error(`grant: ${r.rawLog}`);
  console.log(`  grant ${r.transactionHash}`);
}
await new Promise((r) => setTimeout(r, 6_000));
st = await status(lender);
console.log(JSON.stringify(st));
