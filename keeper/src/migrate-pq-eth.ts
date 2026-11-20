/**
 * Moves the live route onto the quantum-resilient Ethereum leg, idempotently (each step recorded in
 * deployments/ethereum-sepolia.json under `pq`):
 *
 *   1  bring every dollar home from Ethereum (the allocator refuses a new receiver while capital is deployed)
 *   2  deploy on Sepolia: ZKNox's ML-DSA-44 lattice verifier, the attester's ML-DSA-44 key (expanded, SSTORE2),
 *      the Merkle WOTS+ verifier, the HybridAttestedMessenger (no owner) and a new receiver on the same issuer
 *   3  point QoreChain at them, every step signed with the admin's ML-DSA-87 key
 *   4  take the old secp256k1-only messenger's right to mint away
 *
 * The keeper must be paused while it runs.
 *
 *   tsx src/migrate-pq-eth.ts
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { encodeAbiParameters, keccak256, pad, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { account } from "./accounts.js";
import { E, Q, send } from "./config.js";
import { artifact, deploy, pqCall, write } from "./evm.js";
import { eth, qore, sleep } from "./net.js";
import { loadDeployments, ROOT, saveDeployments } from "./deployments.js";
import { relayAll } from "./relay.js";
import { bringHome } from "./book.js";
import { snapshot } from "./vault.js";
import { MerkleWots, mldsa44Keys } from "./pqeth.js";

const e = loadDeployments("sepolia");
e.pq ??= {};
const save = () => saveDeployments("sepolia", e);
const b32 = (a: Address) => pad(a, { size: 32 });
const op = (await account("operator")).evm as Address;
const attester = privateKeyToAccount((await account("attester")).privateKey as Hex).address;
const Receiver = artifact("AgamaL1Receiver").abi;

async function once(key: string, fn: () => Promise<any>) {
  if (e.pq[key]) return e.pq[key];
  e.pq[key] = await fn();
  save();
  return e.pq[key];
}

// ---- 1. everything home ----
if (!e.pq.receiver) {
  for (let round = 0; round < 3; round++) {
    const notes = (await eth.readContract({ address: E.receiver, abi: Receiver, functionName: "noteBalance" })) as bigint;
    const position = (await eth.readContract({ address: E.receiver, abi: Receiver, functionName: "positionValue" })) as bigint;
    if (notes > 0n) {
      console.log(`bringing ${Number(position) / 1e6} home`);
      await bringHome(position + 1_000_000n);
    }
    await relayAll();
    const s = await snapshot();
    console.log(`vault deployed ${Number(s.deployed) / 1e6}`);
    if (s.deployed === 0n) break;
    await sleep(15_000);
  }
  const s = await snapshot();
  if (s.deployed !== 0n) throw new Error(`still ${s.deployed} deployed: settle it before moving the receiver`);
}

// ---- 2. the quantum-resilient Ethereum leg ----
const kp = mldsa44Keys();
e.pq.mldsa44RawKey = toHex(kp.publicKey);
save();
const lattice = await once("lattice", () => deploy("sepolia", "operator", "ZKNOX_dilithium"));
const messenger = await once("messenger", () =>
  deploy("sepolia", "operator", "HybridAttestedMessenger", [0, E.usdc, Q.domain ?? 9800, b32(Q.messenger), b32(Q.usdc), attester]));
const mldsa = await once("mldsa44Verifier", async () => {
  const expanded = execFileSync(join(ROOT, "scripts/expand-mldsa44.sh"), [toHex(kp.publicKey)], { encoding: "utf8" }).trim() as Hex;
  return deploy("sepolia", "operator", "MlDsa44AttestationVerifier", [lattice, expanded, keccak256(kp.publicKey)]);
});
const wots = await once("wotsVerifier", async () => {
  const tree = new MerkleWots(10);
  const root = tree.build();
  e.pq.wotsHeight = 10;
  return deploy("sepolia", "operator", "MerkleWotsAttestationVerifier", [root, tree.pubSeed, 10, messenger]);
});
const messengerAbi = artifact("HybridAttestedMessenger").abi;
await once("init", async () => {
  await write("sepolia", "operator", messenger, messengerAbi, "initPqVerifier", [mldsa]);
  e.pq.activeScheme = "mldsa44";
  return true;
});
const usdcAbi = artifact("MockUSDC").abi;
const MINTER = keccak256(toHex("MINTER_ROLE"));
await once("minter", async () => (await write("sepolia", "operator", E.usdc, usdcAbi, "grantRole", [MINTER, messenger]), true));
const receiver = await once("receiver", () =>
  deploy("sepolia", "operator", "AgamaL1Receiver", [E.usdc, messenger, messenger, E.issuer, Q.domain ?? 9800, b32(Q.allocator), op]));
await once("issuerAllows", async () =>
  (await write("sepolia", "operator", E.issuer, artifact("AbfAssetIssuer").abi, "setAllowlisted", [receiver, true]), true));

// ---- 3. QoreChain points at it, ML-DSA-87 signed ----
const enc = (types: string[], values: unknown[]) => encodeAbiParameters(types.map((type) => ({ type })), values as any);
await once("qoreRemote", async () => {
  await pqCall(Q.messenger, artifact("PqAttestedMessenger").abi, "setRemote", "operator", "setRemote",
    enc(["uint32", "bytes32", "bytes32"], [0, b32(messenger), b32(E.usdc)]), [0, b32(messenger), b32(E.usdc)]);
  return true;
});
await once("qoreReceiver", async () => {
  await pqCall(Q.allocator, artifact("CrossChainAllocator").abi, "setRemoteReceiver", "operator", "setRemoteReceiver",
    enc(["bytes32"], [b32(receiver)]), [b32(receiver)]);
  return true;
});

// ---- 4. the old ECDSA-only messenger can no longer mint ----
await once("oldMinterRevoked", async () => (await write("sepolia", "operator", E.usdc, usdcAbi, "revokeRole", [MINTER, E.messenger]), true));

// The record the keeper and the app read: the live Ethereum leg is now the hybrid one.
e.legacy ??= { messenger: E.messenger, receiver: E.receiver };
e.messenger = messenger;
e.receiver = receiver;
e.deployedAtBlock = Number(await eth.getBlockNumber()) - 50;
save();
console.log(JSON.stringify({ messenger, receiver, mldsa44Verifier: mldsa, wotsVerifier: wots, lattice }, null, 2));
void qore;
void send;
