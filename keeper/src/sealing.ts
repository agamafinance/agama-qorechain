/**
 * How Agama uses QoreSeal (ML-KEM-1024 + AES-256-GCM, FIPS 203), in one place. The web app carries the same
 * constants (web/lib/sealing.ts): an envelope sealed for one purpose never opens under another.
 *
 *   dossier   lender -> compliance officer + auditor        sealed in the browser, opened by the keeper
 *   letter    compliance -> lender + auditor                sealed by the keeper, opened in the browser
 *   epoch     data room manager -> approved lenders + auditor   the group key of one membership epoch
 *   batch     a loan tape encrypted under an epoch key (QoreSeal private batches)
 *
 * Every envelope is ML-KEM-1024 only (`mode: "mlkem"`), chosen explicitly: recipients are identified by the
 * ML-KEM key they registered, on QoreChain's KEM registry (officers) or in the AccessRegistry (lenders, bound
 * to an account whose ML-DSA-87 key is proven). Dossiers and letters also bind the lender's address as associated
 * data, so an envelope lifted from one account does not open as another's.
 */
import { hexToBytes, type Address, type Hex } from "viem";
import { fetchMlkemPublicKey } from "@qorechain/qoreseal/network";
import type { SealRecipient } from "@qorechain/qoreseal";
import { account } from "./accounts.js";
import { CHAIN_ID, REST } from "./net.js";

export const SEAL = {
  chainId: CHAIN_ID,
  mode: "mlkem" as const,
  dossier: "agama:kyc-dossier:v1",
  letter: "agama:kyc-letter:v1",
  epoch: "agama:dataroom-epoch:v1",
  tapeContext: "agama:loan-tape:v1",
};

export const aadFor = (a: Address) => new TextEncoder().encode(a.toLowerCase());
export const bytes = (h: Hex) => hexToBytes(h);

const fetchWithUa: typeof fetch = (input, init) =>
  fetch(input, { ...init, headers: { ...(init?.headers ?? {}), "user-agent": "curl/8.7.1" } });

/** An officer's recipient, read from QoreChain's KEM registry rather than from config. */
export async function officer(role: "compliance" | "auditor"): Promise<SealRecipient> {
  const acc = await account(role);
  return { mlkemPublicKey: await fetchMlkemPublicKey({ rest: REST, address: acc.cosmos, fetch: fetchWithUa as any }) };
}
