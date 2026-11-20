/**
 * QoreX, QoreChain's wallet, through its official integration types (@qorechain/qorex-types).
 *
 * Agama talks to its contracts the way QoreX supports today: EVM transactions from the wallet's EIP-1193 provider
 * (`window.qorex.evm`), from an Ethereum-style (coin 60) account whose ML-DSA-87 key is registered. QoreChain admits
 * such a transaction only inside an EVM window, and QoreX opens one in the same approval, hybrid-signed
 * (secp256k1 + ML-DSA-87) and scoped to the contract being called. QoreX 0.4 refuses to sign the cross-VM messages
 * Agama used before (it will not sign what it cannot display), which is why the app moved to this path.
 *
 * The native provider is still read for the account's `qor1` address.
 */
import { getQorexNative, QOREX_DOWNLOAD_URLS, type QorexNativeProvider } from '@qorechain/qorex-types';
import { createWalletClient, custom, getAddress, type Address, type Hex, type WalletClient } from 'viem';
import { diana } from './chains';

export const QOREX_DOWNLOAD = QOREX_DOWNLOAD_URLS;

type Eip1193 = { request(args: { method: string; params?: unknown }): Promise<unknown>; isQoreX?: boolean };

export function qorexEvm(): Eip1193 | null {
  if (typeof window === 'undefined') return null;
  const evm = (window as unknown as { qorex?: { evm?: Eip1193 } }).qorex?.evm;
  return evm && evm.isQoreX ? evm : null;
}

export function qorex(): QorexNativeProvider | null {
  if (typeof window === 'undefined') return null;
  return getQorexNative() ?? null;
}

/** Waits briefly for the extension to inject itself. */
export async function waitForQorex(ms = 1500): Promise<Eip1193 | null> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const e = qorexEvm();
    if (e) return e;
    await new Promise((r) => setTimeout(r, 100));
  }
  return qorexEvm();
}

export type Account = { address: string; evm: Hex; name: string };

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values: number[]) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= G[i];
  }
  return chk;
}
/** The account's qor1 address: the same 20 bytes as its 0x address. */
export function toQor(evm: Hex): string {
  const bytes = evm.slice(2).match(/../g)!.map((h) => parseInt(h, 16));
  const words: number[] = [];
  let acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  const hrp = 'qor';
  const expand = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const mod = polymod([...expand, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31);
  return hrp + '1' + [...words, ...checksum].map((w) => BECH32[w]).join('');
}

export async function connectQorex(): Promise<Account> {
  const e = await waitForQorex();
  if (!e) throw new Error('QoreX is not installed');
  const [address] = (await e.request({ method: 'eth_requestAccounts' })) as string[];
  if (!address) throw new Error('QoreX did not share an account');
  const evm = getAddress(address) as Hex;
  return { address: toQor(evm), evm, name: 'QoreX' };
}

/** A viem wallet client on QoreX's EVM provider, for the connected account. */
export function walletClient(account: Address): WalletClient {
  const e = qorexEvm();
  if (!e) throw new Error('QoreX is not installed');
  return createWalletClient({ account, chain: diana, transport: custom(e) });
}

/** Asks QoreX to sign `message` (EIP-191). Used once, to derive the lender's encryption key. */
export async function personalSign(account: Address, message: string): Promise<Hex> {
  const e = qorexEvm();
  if (!e) throw new Error('QoreX is not installed');
  const hex = ('0x' + Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, '0')).join('')) as Hex;
  return (await e.request({ method: 'personal_sign', params: [hex, account] })) as Hex;
}

/** QoreX's explanation when the active account cannot send EVM transactions, turned into an instruction. */
export function coin60Hint(message: string): string | null {
  if (/coin-60|coin 60|coin-118/i.test(message)) {
    return 'Switch QoreX to an Ethereum account: Your accounts → "Add an Ethereum account (coin 60)", select it, send it a little QOR, then try again.';
  }
  return null;
}
