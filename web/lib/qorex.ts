/**
 * QoreX, QoreChain's wallet, through its official integration types (@qorechain/qorex-types). Its native provider
 * takes the messages a page builds, shows them, hybrid-signs the transaction (secp256k1 + ML-DSA-87, FIPS 204) and
 * broadcasts it. QoreX does not sign EVM transactions yet, so Agama reaches its contracts with MsgCrossVMCall: every
 * deposit, exit and application carries the lender's post-quantum signature, checked by the chain before the EVM runs.
 *
 * After broadcasting, QoreX re-reads the committed transaction and reports its "shield": `shielded` means the
 * ML-DSA-87 layer is in the block. Anything else is surfaced to the lender rather than swallowed.
 */
import {
  getQorexNative,
  hasCapability,
  qorexSignAndBroadcast,
  QOREX_DOWNLOAD_URLS,
  QORECHAIN_TESTNET_CHAIN_ID,
  type QorexNativeProvider,
  type QorexSignAndBroadcastResult,
} from '@qorechain/qorex-types';
import { toHex, type Hex } from 'viem';
import type { EncodedMsg } from './proto';

export type QorexResult = QorexSignAndBroadcastResult;
export const QOREX_DOWNLOAD = QOREX_DOWNLOAD_URLS;

export function qorex(): QorexNativeProvider | null {
  if (typeof window === 'undefined') return null;
  return getQorexNative() ?? null;
}

/** Waits briefly for the extension to inject itself. */
export async function waitForQorex(ms = 1500): Promise<QorexNativeProvider | null> {
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
  await n.enable(QORECHAIN_TESTNET_CHAIN_ID);
  const key = await n.getKey(QORECHAIN_TESTNET_CHAIN_ID);
  // The EVM lane sees the same 20 bytes as a 0x address.
  return { address: key.bech32Address, evm: toHex(Uint8Array.from(key.address)), name: key.name };
}

/** Hands `messages` to QoreX as one transaction. QoreX clamps the gas hint to 100k..5M. */
export async function signAndBroadcast(messages: EncodedMsg[], memo: string, gasLimit: number): Promise<QorexResult> {
  const n = qorex();
  if (!n) throw new Error('QoreX is not installed');
  if (!hasCapability(n, 'signAndBroadcast')) throw new Error('Update QoreX: this version cannot sign and broadcast');
  const res = await qorexSignAndBroadcast(
    {
      chainId: QORECHAIN_TESTNET_CHAIN_ID,
      messages: messages.map((m) => ({ typeUrl: m.typeUrl, value: m.value })),
      memo,
      gasLimit: Math.min(gasLimit, 5_000_000),
    },
    { native: n },
  );
  if (res.code !== 0) throw new Error(`The transaction failed on chain (code ${res.code}).`);
  if (res.shield === 'downgraded') throw new Error('QoreX reports the transaction landed without its ML-DSA-87 layer.');
  return res;
}
