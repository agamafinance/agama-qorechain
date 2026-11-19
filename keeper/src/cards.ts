/**
 * QoreSeal recipient cards for the two officers, signed with QoreSign.
 *
 * The KEM registry holds an account's ML-KEM-1024 key and nothing else. A card adds the X25519 key for QoreSeal's
 * hybrid mode (ML-KEM-1024 and X25519 combined through SHA3-256, safe as long as either holds) and is signed by the
 * account with QoreSign message signing, secp256k1 and ML-DSA-87 together. The app verifies each card against the
 * keys the account registered on chain before sealing a dossier to it, so a forged card can at worst fall back to
 * ML-KEM-1024 alone, never to a key the officer does not hold.
 *
 *   tsx src/cards.ts        writes deployments/recipient-cards.json
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { hexToBytes, type Hex } from "viem";
import { classicalKeyFromPrivate } from "@qorechain/qoresign";
import { signRecipientCard, type RecipientCard } from "@qorechain/qoreseal";
import { account, sealKeys } from "./accounts.js";
import { ROOT } from "./deployments.js";
import { CHAIN_ID } from "./net.js";

export async function card(role: "compliance" | "auditor"): Promise<RecipientCard> {
  const acc = await account(role);
  return signRecipientCard({
    chainId: CHAIN_ID,
    address: acc.cosmos,
    keys: sealKeys(role),
    classicalKey: classicalKeyFromPrivate(hexToBytes(acc.privateKey as Hex), "eth_secp256k1"),
    pqKey: acc.pqc,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cards = { compliance: await card("compliance"), auditor: await card("auditor") };
  writeFileSync(join(ROOT, "deployments/recipient-cards.json"), JSON.stringify(cards, null, 2) + "\n");
  console.log("deployments/recipient-cards.json written");
}
