/**
 * Prepares an Ethereum-style (coin 60) test lender of the funding mnemonic the way QoreX does for a real one: QOR for
 * gas, its ML-DSA-87 key registered with proof of possession, and an EVM window scoped to Agama's contracts (QoreX
 * opens one in its approval; the QoreX test double used by the browser e2e does not, so this does).
 *
 *   tsx src/evmlender.ts <index> [qor]
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StargateClient } from "@cosmjs/stargate";
import { buildRegisterPqcKeyMsg, deriveUnifiedAccount, EthNativeSigner, fetchPqcStatus, openEvmWindowMsg, signProofOfPossession } from "@qorechain/sdk";
import { evmWindowCost } from "@qorechain/evm";
import { Q } from "./config.js";
import { sendNative } from "./native.js";
import { account } from "./accounts.js";
import { CHAIN_ID, REST, RPC, rest, sleep } from "./net.js";

const index = Number(process.argv[2] ?? 2);
const qor = Number(process.argv[3] ?? 6);
const file = join(homedir(), ".config/qorechain/agama-funder.mnemonic");
const m = process.env.QORE_FUNDER_MNEMONIC ?? (existsSync(file) ? readFileSync(file, "utf8").trim() : "");
const acc = await deriveUnifiedAccount(m, index);
console.log(`coin-60 lender #${index}: ${acc.evm} ${acc.cosmos}`);

async function send(messages: any[], mode: "hybrid" | "classical", gas = 700_000) {
  const a = await rest<any>(`/cosmos/auth/v1beta1/accounts/${acc.cosmos}`);
  const base = a.account?.base_account ?? a.account;
  const signer = new EthNativeSigner(acc, { signMode: mode, rest: REST });
  const t = await StargateClient.connect(RPC);
  try {
    const r: any = await signer.signAndBroadcast(t, {
      chainId: CHAIN_ID, accountNumber: BigInt(base.account_number), sequence: BigInt(base.sequence),
      fee: { amount: [{ denom: "uqor", amount: String(Math.ceil(gas * 0.125)) }], gas: String(gas) }, messages,
    } as any);
    if (r.code) throw new Error(r.rawLog);
    return r.transactionHash as string;
  } finally {
    t.disconnect();
  }
}

const bal = await rest<any>(`/cosmos/bank/v1beta1/balances/${acc.cosmos}/by_denom?denom=uqor`).catch(() => ({ balance: { amount: "0" } }));
if (BigInt(bal.balance?.amount ?? "0") < 2_000_000n) {
  // From the operator, not the funding account: that one is a person's own QoreX wallet.
  const op = (await account("operator")).cosmos;
  const tx = await sendNative("operator", [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: op, toAddress: acc.cosmos, amount: [{ denom: "uqor", amount: String(qor * 1e6) }] } }], "hybrid", 250_000);
  console.log(`  ${qor} QOR ${tx}`);
  await sleep(5_000);
}
if (!(await fetchPqcStatus({ rest: REST, address: acc.cosmos })).registered) {
  const pop = signProofOfPossession({ chainId: CHAIN_ID, account: acc.cosmos, keypair: acc.pqc });
  console.log(`  ML-DSA-87 key ${await send([buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession: pop })], "classical")}`);
  await sleep(5_000);
}
const targets = [Q.usdc, Q.access, Q.vault];
const maxValue = evmWindowCost({ gas: 6_000_000n, maxFeePerGas: 250_000_000_000n }) * 200n;
const msg = openEvmWindowMsg({ sender: acc.cosmos, blocks: 17_280n, maxTxs: 200n, maxValue, allowedTargets: targets } as any);
console.log(`  EVM window, scoped to the token, the registry and the vault: ${await send([msg], "hybrid")}`);
