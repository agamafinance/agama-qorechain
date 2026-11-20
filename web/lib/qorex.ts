/**
 * QoreX, QoreChain's wallet, through its official integration types (@qorechain/qorex-types), on the lender's usual
 * QoreX account.
 *
 * QoreX signs only what it can show its user, and it has no screen for MsgCrossVMCall, the message a QoreChain
 * account calls an EVM contract with. So the lender's Agama account is a PqAccount (contracts/src/account): the
 * lender signs each action as a plain-text message (signArbitrary: secp256k1 + ML-DSA-87), Agama's relayer submits
 * it, and the PqAccount checks the ML-DSA-87 signature on chain with pqcVerify before it acts. No EVM window, no
 * grant, no gas: just a signature.
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
import { bytesToHex, parseAbi, toHex, type Hex } from 'viem';
import { qore } from './chains';
import { QORECHAIN } from './deployments';

export type QorexResult = QorexSignAndBroadcastResult;
export const QOREX_DOWNLOAD = QOREX_DOWNLOAD_URLS;
const CHAIN = QORECHAIN_TESTNET_CHAIN_ID;

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

/**
 * `address`: the lender's QoreX account (qor1). `owner`: the same 20 bytes in 0x form, the key holder.
 * `evm`: the lender's Agama account, the PqAccount its ML-DSA-87 key controls; it holds the USDC, the agUSD and the
 * application. Its address is known before it exists (CREATE2); the first signed action creates it.
 */
export type Account = { address: string; evm: Hex; owner: Hex; name: string };

const factoryAbi = parseAbi(['function accountOf(address owner) view returns (address)']);

export async function connectQorex(): Promise<Account> {
  const n = await waitForQorex();
  if (!n) throw new Error('QoreX is not installed');
  await n.enable(CHAIN);
  const key = await n.getKey(CHAIN);
  const owner = toHex(Uint8Array.from(key.address));
  const evm = (await qore.readContract({ address: QORECHAIN.pqAccountFactory, abi: factoryAbi, functionName: 'accountOf', args: [owner] })) as Hex;
  return { address: key.bech32Address, evm: evm.toLowerCase() as Hex, owner, name: key.name };
}

/**
 * Runs a QoreX request; if QoreX answers that it is locked (it locks itself after a while, or when another tab
 * locked it), asks it to connect, which opens its unlock screen, then runs the same request once more. A locked
 * QoreX refuses signing requests outright but answers a connection request with the unlock screen.
 */
export async function withUnlock<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (e) {
    const n = qorex();
    if (!n || !/locked/i.test(String((e as Error)?.message ?? e))) throw e;
    await n.enable(CHAIN);
    return request();
  }
}

/** Hands `messages` to QoreX as one transaction: it shows them, hybrid-signs and broadcasts. */
export async function signAndBroadcast(messages: { typeUrl: string; value: Uint8Array }[], memo: string, gasLimit: number): Promise<QorexResult> {
  const n = qorex();
  if (!n) throw new Error('QoreX is not installed');
  if (!hasCapability(n, 'signAndBroadcast')) throw new Error('Update QoreX: this version cannot sign and broadcast');
  const request = { chainId: CHAIN, messages, memo, gasLimit: Math.min(gasLimit, 5_000_000) };
  let res: QorexResult;
  try {
    res = await withUnlock(() => qorexSignAndBroadcast(request, { native: n }));
  } catch (e) {
    // A load-balanced node can still report the previous account sequence right after a transaction. Nothing was
    // spent: wait for the next blocks and ask once more.
    if (!/sequence mismatch/i.test(String((e as Error)?.message ?? e))) throw e;
    await new Promise((r) => setTimeout(r, 4_000));
    res = await qorexSignAndBroadcast(request, { native: n });
  }
  if (res.code !== 0) throw new Error(`The transaction failed on chain (code ${res.code}).`);
  if (res.shield === 'downgraded') throw new Error('QoreX reports the transaction landed without its ML-DSA-87 layer.');
  return res;
}

/** QoreX's message signature (message-signing-v1): ADR-36 secp256k1 and ML-DSA-87 over `data`. */
export type MessageSignature = { signatureType: string; classical: { keyType: string; publicKey: string; signature: string }; pq?: { algorithmId: number; signature: string } };

export async function signArbitrary(signer: string, data: string): Promise<MessageSignature> {
  const n = qorex() as unknown as { signArbitrary?: (c: string, s: string, d: string) => Promise<MessageSignature> } | null;
  if (!n?.signArbitrary) throw new Error('Update QoreX: this version cannot sign a message');
  return withUnlock(() => n.signArbitrary!(CHAIN, signer, data));
}

/**
 * The signature the lender's encryption key is derived from: the secp256k1 half of a QoreX message signature, which
 * is deterministic (RFC 6979), so the same account gets the same key back on any device.
 */
export async function keySignature(message: string): Promise<Hex> {
  const n = qorex();
  if (!n) throw new Error('QoreX is not installed');
  const { bech32Address } = await withUnlock(() => n.getKey(CHAIN));
  const sig = await signArbitrary(bech32Address, message);
  return bytesToHex(Uint8Array.from(atob(sig.classical.signature), (c) => c.charCodeAt(0)));
}

// ---- authz grant, hand-encoded ---------------------------------------------------------------------------------
class W {
  private c: number[] = [];
  private v(n: number) {
    while (n > 0x7f) {
      this.c.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    this.c.push(n);
  }
  bytes(f: number, b: Uint8Array) {
    this.v((f << 3) | 2);
    this.v(b.length);
    for (const x of b) this.c.push(x);
    return this;
  }
  string(f: number, s: string) {
    return this.bytes(f, new TextEncoder().encode(s));
  }
  varint(f: number, n: number) {
    this.v(f << 3);
    this.v(n);
    return this;
  }
  done() {
    return Uint8Array.from(this.c);
  }
}

/** Signs, in QoreX, an authz grant: Agama's relayer may send MsgCrossVMCall as the lender, for `days`. */
export async function authorizeRelayer(granter: string, relayer: string, days = 7): Promise<QorexResult> {
  const expires = Math.floor(Date.now() / 1000) + days * 86_400;
  const auth = new W().string(1, '/cosmos.authz.v1beta1.GenericAuthorization').bytes(2, new W().string(1, '/qorechain.crossvm.v1.MsgCrossVMCall').done()).done();
  const grant = new W().bytes(1, auth).bytes(2, new W().varint(1, expires).done()).done();
  const msg = { typeUrl: '/cosmos.authz.v1beta1.MsgGrant', value: new W().string(1, granter).string(2, relayer).bytes(3, grant).done() };
  return signAndBroadcast([msg], `Agama: let the relayer execute the actions you sign, for ${days} days`, 300_000);
}
