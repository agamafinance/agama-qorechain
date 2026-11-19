/**
 * QoreX, QoreChain's wallet. Its native provider (`window.qorex.native`) takes the messages a page builds, shows
 * them, hybrid-signs the transaction (secp256k1 + ML-DSA-87, FIPS 204) and broadcasts it. QoreX does not sign EVM
 * transactions yet, so Agama reaches its contracts with MsgCrossVMCall: every deposit, exit and application
 * carries the lender's post-quantum signature, checked by the chain before the EVM runs.
 */
import { toHex, type Hex } from 'viem';
import { COSMOS_CHAIN_ID } from './chains';
import type { EncodedMsg } from './proto';

export type QorexResult = { txHash: string; code: number; height?: number; shield: string };

type NativeProvider = {
  isQoreX: true;
  capabilities?: readonly string[];
  enable(chainId: string): Promise<void | null>;
  getKey(chainId: string): Promise<{ bech32Address: string; address: number[]; name: string }>;
  signAndBroadcast(req: {
    chainId: string;
    messages: { typeUrl: string; value: Uint8Array | number[] }[];
    memo?: string;
    gasLimit?: number | string;
  }): Promise<QorexResult>;
};

declare global {
  interface Window {
    qorex?: { native?: NativeProvider };
  }
}

export function qorex(): NativeProvider | null {
  if (typeof window === 'undefined') return null;
  const n = window.qorex?.native;
  return n && n.isQoreX ? n : null;
}

/** Waits briefly for the extension to inject itself. */
export async function waitForQorex(ms = 1500): Promise<NativeProvider | null> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const n = qorex();
    if (n) return n;
    await new Promise((r) => setTimeout(r, 100));
  }
  return qorex();
}

export type Account = { address: string; evm: Hex; name: string };

export async function connectQorex(): Promise<Account> {
  const n = await waitForQorex();
  if (!n) throw new Error('QoreX is not installed');
  await n.enable(COSMOS_CHAIN_ID);
  const key = await n.getKey(COSMOS_CHAIN_ID);
  // The EVM lane sees the same 20 bytes as a 0x address.
  return { address: key.bech32Address, evm: toHex(Uint8Array.from(key.address)), name: key.name };
}

/** Hands `messages` to QoreX as one transaction. QoreX clamps the gas hint to 100k..5M. */
export async function signAndBroadcast(messages: EncodedMsg[], memo: string, gasLimit: number): Promise<QorexResult> {
  const n = qorex();
  if (!n) throw new Error('QoreX is not installed');
  if (n.capabilities && !n.capabilities.includes('signAndBroadcast')) {
    throw new Error('Update QoreX: this version cannot sign and broadcast');
  }
  const res = await n.signAndBroadcast({
    chainId: COSMOS_CHAIN_ID,
    messages: messages.map((m) => ({ typeUrl: m.typeUrl, value: m.value })),
    memo,
    gasLimit: Math.min(gasLimit, 5_000_000),
  });
  if (res.code !== 0) throw new Error(`The transaction failed on chain (code ${res.code}).`);
  return res;
}
