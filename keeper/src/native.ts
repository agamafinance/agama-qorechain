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
import { BaseError, ContractFunctionRevertedError, encodeFunctionData, hexToBytes, type Abi, type Address, type Hex } from "viem";
import { CHAIN_ID, REST, RPC, qore, rest } from "./net.js";
import { account, treasury, type Role } from "./accounts.js";
import { ERC20_REGISTRY_TYPES } from "./erc20Msgs.js";

export async function treasuryClient(index = 0) {
  const t = await treasury(index);
  const signer = await directSignerFromPrivateKey(t.native.privateKey, "qor");
  const client = await TxClient.connect({ rpcEndpoint: RPC, signer, registry: qorechainRegistry(ERC20_REGISTRY_TYPES as any), pqcKeypair: t.pqc, rest: REST });
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

/**
 * Signs and broadcasts native messages from a role account. `classical` is only for the PQC key registration.
 * Two senders on one account (the keeper and the app's relayer, two serverless instances) can sign the same sequence:
 * on "account sequence mismatch, expected N" it signs again with N, after at least a block.
 */
export async function sendNative(role: Role, messages: EncodeObject[], mode: "hybrid" | "classical" = "hybrid", gas = 800_000, memo = "") {
  let forced: bigint | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      return await sendNativeOnce(role, messages, mode, gas, memo, forced);
    } catch (e) {
      const m = /account sequence mismatch, expected (\d+)/.exec(String((e as Error)?.message ?? e));
      if (!m || attempt >= 6) throw e;
      forced = BigInt(m[1]);
      await new Promise((r) => setTimeout(r, 1_500 + Math.random() * 2_000));
    }
  }
}

async function sendNativeOnce(role: Role, messages: EncodeObject[], mode: "hybrid" | "classical", gas: number, memo: string, forced?: bigint) {
  const acc = await account(role);
  const { accountNumber, sequence: fetched } = await sequence(acc.cosmos);
  const seq = forced != null && forced > fetched ? forced : fetched;
  const signer = new EthNativeSigner(acc, { signMode: mode, rest: REST });
  const transport = await StargateClient.connect(RPC);
  try {
    const res = (await signer.signAndBroadcast(transport, {
      chainId: CHAIN_ID,
      accountNumber,
      sequence: seq,
      fee: { amount: [{ denom: "uqor", amount: String(Math.ceil(gas * 0.125)) }], gas: String(gas) },
      messages,
      memo,
    } as Parameters<EthNativeSigner["signAndBroadcast"]>[1])) as { transactionHash: string; code?: number; rawLog?: string };
    if (res.code) throw new Error(`tx ${res.transactionHash} failed: code ${res.code} ${res.rawLog ?? ""}`);
    return res.transactionHash;
  } finally {
    transport.disconnect();
  }
}

/**
 * A call to an EVM contract on the native lane: MsgCrossVMCall, in object form (the signer's registry knows the type;
 * a value encoded by hand would be re-encoded empty). On the EVM side msg.sender is the role's 0x address, the same
 * 20 bytes, so every msg.sender check holds. It carries no funds: a cross-VM call cannot.
 */
export const crossVmMsg = (sender: string, target: Address, data: Hex): EncodeObject => ({
  typeUrl: "/qorechain.crossvm.v1.MsgCrossVMCall",
  value: { sender, sourceVm: "cosmwasm", targetVm: "evm", targetContract: target, payload: hexToBytes(data), funds: [], async: false, asyncGasLimit: "0", asyncMaxFactor: "0" },
});

/** The committed transaction, once a node has indexed it. */
export async function committed(hash: string, tries = 12): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const t = await rest<any>(`/cosmos/tx/v1beta1/txs/${hash}`).catch(() => null);
    if (t?.tx_response) return t;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error(`${hash} not indexed after ${tries} tries`);
}

export const executedOnEvm = (t: any) =>
  t?.tx_response?.code === 0 &&
  (t.tx_response.events ?? []).some((e: any) => e.type === "crossvm_response" && e.attributes.some((a: any) => a.key === "status" && a.value === "executed"));

/**
 * A contract write from `role` as a hybrid-signed (secp256k1 + ML-DSA-87) native transaction: post-quantum on the
 * explorer, and no EVM window needed. Simulated first from the role's 0x address, so a revert is named before any gas
 * is spent. A cross-VM call meters the EVM execution at about 2.5 times its EVM estimate; on "out of gas" the whole
 * transaction is undone and it is sent again with 1.6 times the gas, twice at most. Leaves no EVM logs: readers
 * decode the calldata of the committed transaction (chain.ts in the keeper, lib/native.ts in the app).
 */
export async function writeNative(role: Role, address: Address, abi: Abi, functionName: string, args: unknown[], memo: string, fallbackGas?: bigint) {
  const acc = await account(role);
  const data = encodeFunctionData({ abi, functionName, args } as any);
  const evmGas = await qore.estimateContractGas({ address, abi, functionName, args, account: acc.evm as Address } as any).catch((e) => {
    if (fallbackGas && !(e instanceof BaseError && e.walk((c) => c instanceof ContractFunctionRevertedError))) return fallbackGas;
    throw e;
  });
  let gas = Math.max(1_200_000, Math.ceil(Number(evmGas) * 2.8) + 400_000);
  for (let attempt = 0; ; attempt++) {
    try {
      const hash = await sendNative(role, [crossVmMsg(acc.cosmos, address, data)], "hybrid", gas, memo);
      const t = await committed(hash);
      if (!executedOnEvm(t)) throw new Error(`${functionName}: cross-VM call not executed in ${hash}`);
      return { hash, gasUsed: BigInt(t.tx_response.gas_used), tx: t };
    } catch (e) {
      if (attempt < 2 && /out of gas/i.test(String((e as Error)?.message ?? e))) {
        gas = Math.ceil(gas * 1.6);
        continue;
      }
      throw e;
    }
  }
}

export async function qorBalance(address: string): Promise<bigint> {
  const b = await rest<{ balance?: { amount: string } }>(`/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=uqor`).catch(() => ({ balance: undefined }));
  return BigInt(b.balance?.amount ?? "0");
}
