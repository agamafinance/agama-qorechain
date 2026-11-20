/**
 * Switches the Ethereum messenger's post-quantum verifier, attested by the current keys (secp256k1 AND the current
 * post-quantum scheme). There is no owner: this is the only way the attesters change.
 *
 *   tsx src/rotate-eth-pq.ts mldsa44|wots
 */
import { encodeAbiParameters, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { account } from "./accounts.js";
import { E, send } from "./config.js";
import { artifact } from "./evm.js";
import { eth } from "./net.js";
import { loadDeployments, saveDeployments } from "./deployments.js";
import { MerkleWots, signMlDsa44 } from "./pqeth.js";

const to = process.argv[2] as "mldsa44" | "wots";
const next = (to === "wots" ? E.pq.wotsVerifier : E.pq.mldsa44Verifier) as Address;
const abi = artifact("HybridAttestedMessenger").abi;
const attester = privateKeyToAccount((await account("attester")).privateKey as Hex);
const current = (await eth.readContract({ address: E.messenger, abi, functionName: "pqVerifier" })) as Address;
if (current.toLowerCase() === next.toLowerCase()) {
  console.log(`already on ${to}`);
  process.exit(0);
}
const digest = (await eth.readContract({ address: E.messenger, abi, functionName: "rotationDigest", args: [attester.address, next] })) as Hex;
let proof: Hex;
if (current.toLowerCase() === String(E.pq.wotsVerifier).toLowerCase()) {
  const leaf = Number(await eth.readContract({ address: current, abi: artifact("MerkleWotsAttestationVerifier").abi, functionName: "nextLeaf" }));
  proof = new MerkleWots(E.pq.wotsHeight ?? 10).sign(leaf, digest);
} else {
  proof = signMlDsa44(digest);
}
const attestation = encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [await attester.sign({ hash: digest }), proof]);
await send("sepolia", E.messenger, abi, "rotate", [attester.address, next, attestation], { gas: 12_000_000n, label: `rotate to ${to}` });
const e = loadDeployments("sepolia");
e.pq.activeScheme = to;
saveDeployments("sepolia", e);
console.log(`Ethereum leg now attested by secp256k1 + ${to === "wots" ? "Merkle WOTS+" : "ML-DSA-44"}`);
