// The relayer and the attester. Reads MessageSent off each messenger and executes it through the contract named
// as its destinationCaller, with the attestation each side can check:
//
//   QoreChain -> Ethereum   secp256k1 over keccak256(message), as Circle's attesters sign; Ethereum cannot verify
//                           ML-DSA-87 at a sane gas cost
//   Ethereum -> QoreChain   ML-DSA-87 over the messenger's `attestationMessage`, checked by pqcVerify against the
//                           attester's key in QoreChain's registry
import { decodeEventLog, encodeAbiParameters, keccak256, parseAbiItem, slice, type Address, type Hex, type PublicClient } from "viem";
import { MerkleWots, signMlDsa44 } from "./pqeth.js";
import { privateKeyToAccount } from "viem/accounts";
import { account } from "./accounts.js";
import { E, Q, send } from "./config.js";
import { artifact, pqSign } from "./evm.js";
import { eth, qore, sleep } from "./net.js";
import { load, save } from "./state.js";
import { nativeAllocationMessages } from "./chain.js";

const MessageSent = parseAbiItem("event MessageSent(bytes message)");
const QORE_LOG_RANGE = 10_000;
const ETH_LOG_RANGE = 1_000;

async function getLogsPatiently(client: PublicClient, address: Address, from: number, to: number) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.getLogs({ address, event: MessageSent, fromBlock: BigInt(from), toBlock: BigInt(to) });
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(2_000 * (attempt + 1));
    }
  }
}

/// Reads MessageSent page by page. A page that fails stops the scan where it is, and the caller keeps the progress.
export async function scan(client: PublicClient, address: Address, from: number, chunk: number) {
  const head = Number(await client.getBlockNumber());
  const messages: Hex[] = [];
  let reached = from - 1;
  let error: unknown;
  for (let start = from; start <= head; start += chunk) {
    const end = Math.min(start + chunk - 1, head);
    try {
      const logs = await getLogsPatiently(client, address, start, end);
      for (const l of logs) messages.push(decodeEventLog({ abi: [MessageSent], data: l.data, topics: l.topics }).args.message);
      reached = end;
    } catch (e) {
      error = e;
      break;
    }
  }
  return { messages, head: reached, error };
}

const nonceOf = (m: Hex) => slice(m, 12, 44);
/// CCTP V2 header: version 4 | source 4 | destination 4 | nonce 32 | sender 32 | recipient 32 (bytes 76 to 108).
const recipientOf = (m: Hex) => ("0x" + m.slice(2 + (76 + 12) * 2, 2 + 108 * 2)).toLowerCase();

let wots: MerkleWots | undefined;
const wotsSpent = new Set<number>();

/// The Ethereum leg's attestation. On the hybrid messenger: the attester's secp256k1 signature AND a post-quantum
/// proof over the messenger's `attestationDigest`, either ML-DSA-44 (FIPS 204, QoreChain's PQC kit) or a Merkle WOTS+
/// one-time signature, whichever verifier the messenger holds. On the legacy messenger: secp256k1 alone.
export async function attestForEthereum(message: Hex): Promise<Hex> {
  const signer = privateKeyToAccount((await account("attester")).privateKey as Hex);
  if (!E.pq?.messenger) return signer.sign({ hash: keccak256(message) });
  const messengerAbi = artifact("HybridAttestedMessenger").abi;
  const digest = (await eth.readContract({ address: E.messenger, abi: messengerAbi, functionName: "attestationDigest", args: [message] })) as Hex;
  const ecdsa = await signer.sign({ hash: digest });
  const verifier = (await eth.readContract({ address: E.messenger, abi: messengerAbi, functionName: "pqVerifier" })) as Address;
  let proof: Hex;
  if (verifier.toLowerCase() === String(E.pq.wotsVerifier).toLowerCase()) {
    wots ??= new MerkleWots(E.pq.wotsHeight ?? 10);
    // One leaf per attestation, ever: the next one the chain has not seen, and never one this process already used.
    let leaf = Number(await eth.readContract({ address: verifier, abi: artifact("MerkleWotsAttestationVerifier").abi, functionName: "nextLeaf" }));
    while (wotsSpent.has(leaf)) leaf++;
    wotsSpent.add(leaf);
    proof = wots.sign(leaf, digest);
  } else {
    proof = signMlDsa44(digest);
  }
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [ecdsa, proof]);
}

/// ML-DSA-87 attestation for the QoreChain leg: 4,627 bytes, over the exact bytes the messenger checks.
export async function attestForQoreChain(message: Hex): Promise<Hex> {
  const bytes = (await qore.readContract({
    address: Q.messenger, abi: artifact("PqAttestedMessenger").abi, functionName: "attestationMessage", args: [message],
  })) as Hex;
  return pqSign("attester", bytes);
}

const messengerAbi = () => artifact("AttestedMessenger").abi;

export async function relayAll(): Promise<number> {
  const state = load();
  let done = 0;

  // QoreChain to Ethereum: allocations, executed by the receiver, which subscribes them to the issuer.
  // Two sources, merged: MessageSent logs (allocations sent on the EVM lane, before the switch) and the messages of
  // allocations sent on the native lane, which log nothing and are rebuilt from calldata and state (chain.ts).
  const out = await scan(qore as PublicClient, Q.messenger, state.qoreBlock, QORE_LOG_RANGE);
  const native = await nativeAllocationMessages(state.qoreNativeHeight ?? state.qoreBlock);
  const seen = new Set<string>();
  for (const m of [...out.messages, ...native.map((x) => x.message)]) {
    if (seen.has(m.toLowerCase())) continue;
    seen.add(m.toLowerCase());
    // Only messages addressed to the live Ethereum messenger: after a migration the log scan still sees the ones
    // its predecessors already delivered, and retrying those stalled a whole keeper run (FINDINGS 18).
    if (recipientOf(m) !== String(E.messenger).toLowerCase()) continue;
    const used = await eth.readContract({ address: E.messenger, abi: messengerAbi(), functionName: "usedNonces", args: [nonceOf(m)] });
    if (used) continue;
    await send("sepolia", E.receiver, artifact("AgamaL1Receiver").abi, "relay", [m, await attestForEthereum(m)], {
      label: E.pq?.messenger ? "relay to Ethereum (hybrid PQ)" : "relay to Ethereum", gas: 15_000_000n,
    });
    done++;
  }
  // Rewind a little so a log the node had not indexed yet is read next time; nonces make that idempotent.
  const lastNative = native.at(-1)?.height;
  save({ ...state, qoreBlock: Math.max(out.head - 300, state.qoreBlock), qoreNativeHeight: Math.max(lastNative ? lastNative - 300 : 0, state.qoreNativeHeight ?? state.qoreBlock) });
  if (out.error) throw out.error;

  // Ethereum to QoreChain: returns, settled by the allocator into the vault, attested post-quantum.
  const back = await scan(eth as PublicClient, E.messenger, state.ethBlock, ETH_LOG_RANGE);
  // Only returns from Agama's own receivers are the allocator's to settle; anything else burned towards QoreChain
  // (a test burn, a message whose nonce was already spent) is skipped rather than retried forever.
  const ours = new Set([E.receiver, E.legacy?.receiver, ...(E.retiredReceivers ?? [])].filter(Boolean).map((a: string) => a.toLowerCase()));
  for (const m of back.messages) {
    const used = await qore.readContract({ address: Q.messenger, abi: messengerAbi(), functionName: "usedNonces", args: [nonceOf(m)] });
    if (used) continue;
    // CCTP V2: the burn body starts at byte 148; its messageSender is the 32-byte word at body offset 100.
    const sender = ("0x" + m.slice(2 + (148 + 100 + 12) * 2, 2 + (148 + 132) * 2)).toLowerCase();
    if (!ours.has(sender)) continue;
    try {
      await send("qorechain", Q.allocator, artifact("CrossChainAllocator").abi, "settleReturn", [m, await attestForQoreChain(m)], {
        label: "settle on QoreChain", gas: 1_500_000n,
      });
      done++;
    } catch (e) {
      console.log(`  ::warning:: return ${nonceOf(m).slice(0, 10)} not settled: ${(e as Error).message.split("\n")[0].slice(0, 160)}`);
    }
  }
  save({ ...load(), ethBlock: Math.max(back.head - 20, state.ethBlock) });
  if (back.error) throw back.error;
  return done;
}
