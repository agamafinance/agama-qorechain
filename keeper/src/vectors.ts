/**
 * Test vectors for the Ethereum-side post-quantum verifiers, made with the same code the keeper signs with:
 * contracts/test/vectors/pq.json. Fixed test seeds only, never the production keys.
 *
 *   tsx src/vectors.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mldsa44 } from "@qorechain/pqc";
import { keccak256, toBytes, toHex, type Hex } from "viem";
import { MerkleWots } from "./pqeth.js";
import { ROOT } from "./deployments.js";

const digest = (s: string) => keccak256(toBytes(s));
const kp = mldsa44.keygen(new Uint8Array(32).fill(0x11));
const d1 = digest("agama test attestation 1");
const expanded = execFileSync(join(ROOT, "scripts/expand-mldsa44.sh"), [toHex(kp.publicKey)], { encoding: "utf8" }).trim();

const wots = new MerkleWots(4, "vectors", new Uint8Array(32).fill(0x22), toHex(new Uint8Array(32).fill(0x33)));
const root = wots.build();
const leaves = [0, 1, 5, 15];
const out = {
  mldsa44: {
    rawKey: toHex(kp.publicKey),
    rawKeyHash: keccak256(kp.publicKey),
    expandedKey: expanded,
    digest: d1,
    signature: toHex(mldsa44.sign(kp.secretKey, toBytes(d1))),
  },
  wots: {
    height: 4,
    pubSeed: wots.pubSeed,
    root,
    digests: leaves.map((l) => digest(`agama wots ${l}`)),
    leaves,
    signatures: leaves.map((l) => wots.sign(l, digest(`agama wots ${l}`)) as Hex),
  },
};
mkdirSync(join(ROOT, "contracts/test/vectors"), { recursive: true });
writeFileSync(join(ROOT, "contracts/test/vectors/pq.json"), JSON.stringify(out, null, 2) + "\n");
console.log("contracts/test/vectors/pq.json written");
