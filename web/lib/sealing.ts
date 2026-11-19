/**
 * QoreSeal in the browser. The same purposes as the keeper (keeper/src/sealing.ts): an envelope sealed for one
 * purpose never opens under another, and dossiers and letters are bound to the lender's address.
 *
 * The lender's key pair (ML-KEM-1024 + X25519) is generated here, from 32 random bytes, and never leaves the
 * browser: its seed is kept in this browser's storage and offered as a backup file. Only the ML-KEM-1024 public key
 * is published, on chain, by a transaction QoreX signs with the lender's ML-DSA-87 key.
 */
import { generateSealKeys, open, seal, sealKeysFromSeed, type SealKeyPair, type SealRecipient } from '@qorechain/qoreseal';
import { bytesToHex, hexToBytes, type Hex } from 'viem';
import { COSMOS_CHAIN_ID } from './chains';

export const SEAL = {
  chainId: COSMOS_CHAIN_ID,
  mode: 'mlkem' as const,
  dossier: 'agama:kyc-dossier:v1',
  letter: 'agama:kyc-letter:v1',
  epoch: 'agama:dataroom-epoch:v1',
  tapeContext: 'agama:loan-tape:v1',
};

export const aadFor = (a: string) => new TextEncoder().encode(a.toLowerCase());

const storageKey = (evm: string) => `agama-qore:seal:${evm.toLowerCase()}`;

export function loadKeys(evm: string): SealKeyPair | null {
  if (typeof window === 'undefined') return null;
  const seed = localStorage.getItem(storageKey(evm));
  return seed ? sealKeysFromSeed(hexToBytes(seed as Hex)) : null;
}

export function createKeys(evm: string): SealKeyPair {
  const keys = generateSealKeys();
  localStorage.setItem(storageKey(evm), bytesToHex(keys.seed));
  return keys;
}

export function importSeed(evm: string, seedHex: string): SealKeyPair {
  const keys = sealKeysFromSeed(hexToBytes(seedHex.trim() as Hex));
  localStorage.setItem(storageKey(evm), bytesToHex(keys.seed));
  return keys;
}

export function backupFile(evm: string, keys: SealKeyPair) {
  const body = JSON.stringify(
    {
      what: 'Agama on QoreChain: your QoreSeal key (ML-KEM-1024 + X25519). Anyone with this seed reads what was sealed to you.',
      account: evm,
      seed: bytesToHex(keys.seed),
    },
    null,
    2,
  );
  return new Blob([body], { type: 'application/json' });
}

/// Seals the dossier to the officers: hybrid (ML-KEM-1024 + X25519) when both cards verified, ML-KEM-1024 alone
/// otherwise, chosen explicitly either way.
export function sealDossier(evm: string, recipients: SealRecipient[], dossier: unknown, hybrid: boolean): Hex {
  return bytesToHex(
    seal({
      chainId: SEAL.chainId,
      purpose: SEAL.dossier,
      mode: hybrid ? 'hybrid' : 'mlkem',
      aad: aadFor(evm),
      recipients,
      plaintext: new TextEncoder().encode(JSON.stringify(dossier)),
    }),
  );
}

export function openLetter<T>(evm: string, keys: SealKeyPair, envelope: Hex): T {
  const pt = open({ chainId: SEAL.chainId, purpose: SEAL.letter, envelope: hexToBytes(envelope), keys, aad: aadFor(evm) });
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}
