/**
 * Hybrid-signed (secp256k1 + ML-DSA-87) native QoreChain transactions from Agama's relayer, server-side. The same path
 * as the keeper's (keeper/src/native.ts writeNative): a MsgCrossVMCall in object form, simulated first, metered at
 * about 2.5 times the EVM estimate, success only on code 0 and crossvm_response "executed". No EVM window exists for
 * the relayer: an ECDSA-only EVM transaction from it is refused by the chain.
 *
 * Secrets: RELAYER_PRIVATE_KEY (the secp256k1 key) and RELAYER_PQC_SEED (the 32-byte seed of its ML-DSA-87 key, as
 * deriveUnifiedAccount derives it). Never the mnemonic.
 */
import { StargateClient } from '@cosmjs/stargate';
import type { EncodeObject } from '@cosmjs/proto-signing';
import { EthNativeSigner, generatePqcKeypair, qoreAddresses, type UnifiedAccount } from '@qorechain/sdk';
import { BaseError, ContractFunctionRevertedError, encodeFunctionData, hexToBytes, toHex, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { COSMOS_CHAIN_ID, qore } from '../chains';

const REST = process.env.QORE_REST_UPSTREAM ?? 'https://api-testnet.qore.host';
const RPC = process.env.QORE_RPC_UPSTREAM ?? 'https://rpc-testnet.qore.host';

export const relayerConfigured = () =>
  /^0x[0-9a-fA-F]{64}$/.test(process.env.RELAYER_PRIVATE_KEY?.trim() ?? '') && /^[0-9a-fA-F]{64}$/.test(process.env.RELAYER_PQC_SEED?.trim() ?? '');

let cached: UnifiedAccount | undefined;
function relayer(): UnifiedAccount {
  if (cached) return cached;
  const privateKey = process.env.RELAYER_PRIVATE_KEY!.trim() as Hex;
  const a = privateKeyToAccount(privateKey);
  const raw = hexToBytes(a.publicKey);
  const compressed = toHex(Uint8Array.from([raw[64] % 2 === 0 ? 2 : 3, ...raw.slice(1, 33)]));
  const pqc = generatePqcKeypair(hexToBytes(`0x${process.env.RELAYER_PQC_SEED!.trim()}`));
  cached = { ...qoreAddresses({ evm: a.address }), privateKey, publicKey: compressed, pqc } as UnifiedAccount;
  return cached;
}

const json = async (path: string) => {
  const r = await fetch(`${REST}${path}`, { headers: { accept: 'application/json', 'user-agent': 'agama-qorechain/1.0' }, cache: 'no-store' });
  if (!r.ok) throw Object.assign(new Error(`${path.split('?')[0]}: ${r.status}`), { status: r.status });
  return r.json();
};

async function sequence(address: string) {
  const body = await json(`/cosmos/auth/v1beta1/accounts/${address}`);
  const acc = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  return { accountNumber: BigInt(acc.account_number ?? '0'), sequence: BigInt(acc.sequence ?? '0') };
}

/** Two instances signing at once: on "account sequence mismatch, expected N", sign again with N after a block. */
async function sendNative(messages: EncodeObject[], gas: number, memo: string): Promise<string> {
  let forced: bigint | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      const acc = relayer();
      const { accountNumber, sequence: fetched } = await sequence(acc.cosmos);
      const seq = forced != null && forced > fetched ? forced : fetched;
      const signer = new EthNativeSigner(acc, { signMode: 'hybrid', rest: REST });
      const transport = await StargateClient.connect(RPC);
      try {
        const res = (await signer.signAndBroadcast(transport, {
          chainId: COSMOS_CHAIN_ID,
          accountNumber,
          sequence: seq,
          fee: { amount: [{ denom: 'uqor', amount: String(Math.ceil(gas * 0.125)) }], gas: String(gas) },
          messages,
          memo,
        } as Parameters<EthNativeSigner['signAndBroadcast']>[1])) as { transactionHash: string; code?: number; rawLog?: string };
        if (res.code) throw new Error(`tx ${res.transactionHash} failed: code ${res.code} ${res.rawLog ?? ''}`);
        return res.transactionHash;
      } finally {
        transport.disconnect();
      }
    } catch (e) {
      const m = /account sequence mismatch, expected (\d+)/.exec(String((e as Error)?.message ?? e));
      if (!m || attempt >= 6) throw e;
      forced = BigInt(m[1]);
      await new Promise((r) => setTimeout(r, 1_500 + Math.random() * 2_000));
    }
  }
}

async function committed(hash: string) {
  for (let i = 0; i < 20; i++) {
    const t = await json(`/cosmos/tx/v1beta1/txs/${hash}`).catch(() => null);
    if (t?.tx_response) return t;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error(`${hash} was not indexed in time`);
}

/** One contract call from the relayer, on the native lane. Returns the native hash, the one the explorer knows. */
export async function writeNative(address: Address, abi: Abi, functionName: string, args: readonly unknown[], memo: string) {
  const acc = relayer();
  const data = encodeFunctionData({ abi, functionName, args } as never);
  // The simulation runs the contract, the PqAccount's pqcVerify included: a refused message costs nothing.
  const evmGas = await qore.estimateContractGas({ address, abi, functionName, args, account: acc.evm as Address } as never);
  let gas = Math.max(1_200_000, Math.ceil(Number(evmGas) * 2.8) + 400_000);
  const msg = {
    typeUrl: '/qorechain.crossvm.v1.MsgCrossVMCall',
    value: { sender: acc.cosmos, sourceVm: 'cosmwasm', targetVm: 'evm', targetContract: address, payload: hexToBytes(data), funds: [], async: false, asyncGasLimit: '0', asyncMaxFactor: '0' },
  };
  for (let attempt = 0; ; attempt++) {
    try {
      const hash = await sendNative([msg], gas, memo);
      const t = await committed(hash);
      const executed = (t.tx_response.events ?? []).some(
        (e: { type: string; attributes: { key: string; value: string }[] }) => e.type === 'crossvm_response' && e.attributes.some((x) => x.key === 'status' && x.value === 'executed'),
      );
      if (t.tx_response.code !== 0 || !executed) throw new Error(`the call was not executed (${hash})`);
      return { hash, gasUsed: String(t.tx_response.gas_used) };
    } catch (e) {
      if (attempt < 2 && /out of gas/i.test(String((e as Error)?.message ?? e))) {
        gas = Math.ceil(gas * 1.6);
        continue;
      }
      throw e;
    }
  }
}

export const isRevert = (e: unknown) => e instanceof BaseError && !!e.walk((c) => c instanceof ContractFunctionRevertedError);
