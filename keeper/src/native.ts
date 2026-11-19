/**
 * Hybrid-signed (secp256k1 + ML-DSA-87) native-lane transactions.
 *
 *  - The treasury is a coin-118 account: a cosmjs DIRECT signer plus its canonical ML-DSA-87 key.
 *  - The role accounts are eth_secp256k1 (coin 60): they sign native messages through the SDK's EthNativeSigner,
 *    exactly as QoreX does for an Ethereum-type account.
 */
import { StargateClient } from "@cosmjs/stargate";
import type { EncodeObject } from "@cosmjs/proto-signing";
import { EthNativeSigner, TxClient, directSignerFromPrivateKey, ensurePqcRegistered, qorechainRegistry } from "@qorechain/sdk";
import { CHAIN_ID, REST, RPC, rest } from "./net.js";
import { account, treasury, type Role } from "./accounts.js";

export async function treasuryClient(index = 0) {
  const t = await treasury(index);
  const signer = await directSignerFromPrivateKey(t.native.privateKey, "qor");
  const client = await TxClient.connect({ rpcEndpoint: RPC, signer, registry: qorechainRegistry(), pqcKeypair: t.pqc, rest: REST });
  // Registers the account's canonical ML-DSA-87 key (the one QoreX derives from the same mnemonic) the first time.
  await ensurePqcRegistered(client, { pqcKeypair: t.pqc, rest: REST } as any);
  return { client, address: t.native.address };
}

async function sequence(address: string) {
  const body = await rest<{ account?: Record<string, any> }>(`/cosmos/auth/v1beta1/accounts/${address}`).catch((e) => {
    if (e.status === 404) throw new Error(`${address} does not exist on chain yet: fund it first`);
    throw e;
  });
  const acc = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  return { accountNumber: BigInt(acc.account_number ?? "0"), sequence: BigInt(acc.sequence ?? "0") };
}

/** Signs and broadcasts native messages from a role account. `classical` is only for the PQC key registration. */
export async function sendNative(role: Role, messages: EncodeObject[], mode: "hybrid" | "classical" = "hybrid", gas = 800_000) {
  const acc = await account(role);
  const { accountNumber, sequence: seq } = await sequence(acc.cosmos);
  const signer = new EthNativeSigner(acc, { signMode: mode, rest: REST });
  const transport = await StargateClient.connect(RPC);
  try {
    const res = (await signer.signAndBroadcast(transport, {
      chainId: CHAIN_ID,
      accountNumber,
      sequence: seq,
      fee: { amount: [{ denom: "uqor", amount: String(Math.ceil(gas * 0.125)) }], gas: String(gas) },
      messages,
    } as Parameters<EthNativeSigner["signAndBroadcast"]>[1])) as { transactionHash: string; code?: number; rawLog?: string };
    if (res.code) throw new Error(`tx ${res.transactionHash} failed: code ${res.code} ${res.rawLog ?? ""}`);
    return res.transactionHash;
  } finally {
    transport.disconnect();
  }
}

export async function qorBalance(address: string): Promise<bigint> {
  const b = await rest<{ balance?: { amount: string } }>(`/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=uqor`).catch(() => ({ balance: undefined }));
  return BigInt(b.balance?.amount ?? "0");
}
