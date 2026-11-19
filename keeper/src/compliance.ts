/**
 * The compliance officer, automated for the testnet. Opens each sealed dossier with its ML-KEM-1024 key, applies
 * the vault's eligibility policy, seals the decision letter to the lender and the auditor, and signs the decision
 * with ML-DSA-87. The AccessRegistry accepts it only after pqcVerify has checked that signature against the
 * officer's registered key, and only for the exact dossier the officer read.
 *
 * The policy is a stand-in for a real KYC provider: it reads what the lender declared and checks it is complete,
 * from an allowed jurisdiction and for an investor category the note may be sold to. Nothing here is written to
 * the chain in clear: the dossier stays sealed, and the decision text is sealed too.
 */
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import { open, seal } from "@qorechain/qoreseal";
import { sealKeys } from "./accounts.js";
import { Q, send } from "./config.js";
import { artifact, pqAuthorize } from "./evm.js";
import { qore } from "./net.js";
import { aadFor, bytes, officer, SEAL } from "./sealing.js";
import { dossierProvenance, type Provenance } from "./provenance.js";

const AccessAbi = artifact("AccessRegistry").abi;

/** What a lender declares, sealed. */
export type Dossier = {
  v: 1;
  name: string;
  email?: string;
  country: string; // ISO 3166-1 alpha-2
  investorType: "professional" | "institutional" | "accredited-individual" | "retail";
  entity?: string;
  sourceOfFunds?: string;
  attestations: { notUsPerson: boolean; notSanctioned: boolean; understandsRisk: boolean };
  declaredAt: string;
};

export type Letter = {
  v: 1;
  decision: "approved" | "rejected";
  tier?: number;
  tierName?: string;
  expiresAt?: number;
  reasons: string[];
  dossierHash: Hex;
  reviewedAt: string;
  reviewer: string;
  /** The filing transaction, both of its signatures verified by the officer with QoreSign. */
  provenance?: Provenance;
};

const BLOCKED = new Set(["KP", "IR", "SY", "CU", "RU", "BY", "MM", "US"]);
const TIERS: Record<string, [number, string]> = {
  institutional: [2, "Institutional"],
  professional: [1, "Professional"],
  "accredited-individual": [1, "Accredited individual"],
};
const VALIDITY_DAYS = 180;

export function decide(d: Partial<Dossier>, dossierHash: Hex): Letter {
  const reasons: string[] = [];
  if (d.v !== 1) reasons.push("Unknown dossier format.");
  if (!d.name || d.name.trim().length < 2) reasons.push("A legal name is required.");
  if (!d.country || !/^[A-Z]{2}$/.test(d.country)) reasons.push("A country of residence is required.");
  else if (BLOCKED.has(d.country)) reasons.push(`The note cannot be offered to residents of ${d.country}.`);
  if (!d.investorType || !TIERS[d.investorType]) reasons.push("The note is reserved to professional, institutional and accredited investors.");
  if (!d.attestations?.notUsPerson) reasons.push("The note is not offered to US persons.");
  if (!d.attestations?.notSanctioned) reasons.push("A sanctions declaration is required.");
  if (!d.attestations?.understandsRisk) reasons.push("The risk acknowledgement is required.");
  const base = { v: 1 as const, dossierHash, reviewedAt: new Date().toISOString(), reviewer: "Agama compliance (automated, testnet)" };
  if (reasons.length) return { ...base, decision: "rejected", reasons };
  const [tier, tierName] = TIERS[d.investorType!];
  const expiresAt = Math.floor(Date.now() / 1000) + VALIDITY_DAYS * 86_400;
  return { ...base, decision: "approved", tier, tierName, expiresAt, reasons: [`Eligible as ${tierName.toLowerCase()} investor for ${VALIDITY_DAYS} days.`] };
}

async function lenderKey(a: Address): Promise<Uint8Array> {
  const k = (await qore.readContract({ address: Q.access, abi: AccessAbi, functionName: "encryptionKey", args: [a] })) as Hex;
  return bytes(k);
}

/** Reviews every dossier waiting for a decision. Returns how many were decided. */
export async function reviewDossiers(): Promise<number> {
  const [waiting] = (await qore.readContract({ address: Q.access, abi: AccessAbi, functionName: "pending", args: [0n, 25n] })) as [Address[], bigint];
  if (!waiting.length) return 0;
  const keys = sealKeys("compliance");
  const auditor = await officer("auditor");
  let decided = 0;

  for (const a of waiting) {
    const envelope = (await qore.readContract({ address: Q.access, abi: AccessAbi, functionName: "dossier", args: [a] })) as Hex;
    const dossierHash = keccak256(envelope);
    // Read nothing until the filing transaction is found and both its signatures check out. Not found yet means the
    // node has not indexed it: the next tick tries again.
    const provenance = await dossierProvenance(Q.access, a, dossierHash).catch(() => null);
    if (!provenance) {
      console.log(`  ${a}: filing transaction not indexed yet, next tick`);
      continue;
    }
    let dossier: Partial<Dossier> = {};
    try {
      const pt = open({ chainId: SEAL.chainId, purpose: SEAL.dossier, envelope: bytes(envelope), keys, aad: aadFor(a) });
      dossier = JSON.parse(new TextDecoder().decode(pt));
    } catch (e) {
      console.log(`  dossier of ${a} does not open for compliance: ${(e as Error).message}`);
    }
    const letter = { ...decide(provenance.classical && provenance.postQuantum ? dossier : {}, dossierHash), provenance };
    if (!provenance.postQuantum) letter.reasons.unshift("The filing transaction's ML-DSA-87 signature did not verify.");
    const sealed = toHex(seal({
      chainId: SEAL.chainId, purpose: SEAL.letter, mode: SEAL.mode, aad: aadFor(a),
      recipients: [{ mlkemPublicKey: await lenderKey(a) }, auditor],
      plaintext: new TextEncoder().encode(JSON.stringify(letter)),
    }));

    if (letter.decision === "approved") {
      const tier = letter.tier!, exp = BigInt(letter.expiresAt!);
      const params = encodeAbiParameters(
        [{ type: "address" }, { type: "uint8" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }],
        [a, tier, exp, dossierHash, keccak256(sealed)],
      );
      const [deadline, sig] = await pqAuthorize(Q.access, AccessAbi, "compliance", "approve", params);
      await send("qorechain", Q.access, AccessAbi, "approve", [a, tier, exp, dossierHash, sealed, deadline, sig], { gas: 2_500_000n, label: "approve (ML-DSA)" });
    } else {
      const params = encodeAbiParameters([{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }], [a, dossierHash, keccak256(sealed)]);
      const [deadline, sig] = await pqAuthorize(Q.access, AccessAbi, "compliance", "reject", params);
      await send("qorechain", Q.access, AccessAbi, "reject", [a, dossierHash, sealed, deadline, sig], { gas: 2_500_000n, label: "reject (ML-DSA)" });
    }
    console.log(`  ${a}: ${letter.decision}${letter.tierName ? ` (${letter.tierName})` : ""}`);
    decided++;
  }
  return decided;
}
