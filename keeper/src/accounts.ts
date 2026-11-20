/**
 * Agama's testnet accounts, all derived from one BIP-39 mnemonic (QORE_MNEMONIC, or the file
 * ~/.config/qorechain/testnet.mnemonic). Testnet only: never reuse it on mainnet.
 *
 *   treasury    m/44'/118'/0'/0/0   the QoreX account that takes the faucet; funds the others
 *   operator    coin 60, index 10   deploys, relays and allocates from a scoped EVM window; also the admin key
 *   reporter    index 11            ML-DSA-87 signs the vault's NAV reports, never sends an EVM transaction
 *   compliance  index 12            ML-DSA-87 signs KYC decisions and data room epochs; ML-KEM-1024 opens dossiers
 *   attester    index 13            the bridge: ML-DSA-87 towards QoreChain, secp256k1 towards Ethereum
 *   auditor     index 14            view key only: ML-KEM-1024, reads every dossier and every report
 *   relayer     coin 60, index 15   executes, through authz MsgExec, the actions QoreX lenders sign as intents
 *
 * Indexes 0 to 2 belong to another keeper on the same mnemonic; Agama starts at 10 so nonces and windows never
 * collide.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deriveNativeAccount, derivePqcCanonical, deriveUnifiedAccount, type UnifiedAccount } from "@qorechain/sdk";
import { deriveSealKeys, type SealKeyPair } from "@qorechain/qoreseal";

export function mnemonic(): string {
  const env = process.env.QORE_MNEMONIC?.trim();
  if (env) return env;
  const file = join(homedir(), ".config/qorechain/testnet.mnemonic");
  if (!existsSync(file)) throw new Error("Set QORE_MNEMONIC or create ~/.config/qorechain/testnet.mnemonic");
  return readFileSync(file, "utf8").trim();
}

export const ROLES = ["operator", "reporter", "compliance", "attester", "auditor", "relayer"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_INDEX: Record<Role, number> = { operator: 10, reporter: 11, compliance: 12, attester: 13, auditor: 14, relayer: 15 };

const cache = new Map<Role, Promise<UnifiedAccount>>();
export function account(role: Role): Promise<UnifiedAccount> {
  let a = cache.get(role);
  if (!a) cache.set(role, (a = deriveUnifiedAccount(mnemonic(), ROLE_INDEX[role])));
  return a;
}

/**
 * The QoreX account that funds the role accounts. A separate testnet mnemonic when one is given
 * (QORE_FUNDER_MNEMONIC, or ~/.config/qorechain/agama-funder.mnemonic), else the treasury of the main mnemonic.
 */
export function funderMnemonic(): string {
  const env = process.env.QORE_FUNDER_MNEMONIC?.trim();
  if (env) return env;
  const file = join(homedir(), ".config/qorechain/agama-funder.mnemonic");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : mnemonic();
}

/** A QoreX-style account (coin 118) of the funding mnemonic: index 0 funds, index 1 is the browser e2e lender. */
export async function treasury(index = 0) {
  const m = funderMnemonic();
  const native = await deriveNativeAccount(m, { accountIndex: index });
  return { native, pqc: derivePqcCanonical(native.address, m) };
}

/** The role's QoreSeal key pair (ML-KEM-1024 + X25519), derived from the mnemonic at the role's index. */
export function sealKeys(role: "compliance" | "auditor"): SealKeyPair {
  return deriveSealKeys({ mnemonic: mnemonic(), index: ROLE_INDEX[role] });
}
