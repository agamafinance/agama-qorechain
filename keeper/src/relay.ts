// The relayer and the attester. Reads MessageSent off each messenger and executes it through the contract named
// as its destinationCaller, with the attestation each side can check:
//
//   QoreChain -> Ethereum   secp256k1 over keccak256(message), as Circle's attesters sign; Ethereum cannot verify
//                           ML-DSA-87 at a sane gas cost
//   Ethereum -> QoreChain   ML-DSA-87 over the messenger's `attestationMessage`, checked by pqcVerify against the
//                           attester's key in QoreChain's registry
import { decodeEventLog, keccak256, parseAbiItem, slice, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { account } from "./accounts.js";
import { E, Q, send } from "./config.js";
import { artifact, pqSign } from "./evm.js";
import { eth, qore, sleep } from "./net.js";
import { load, save } from "./state.js";

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

/// secp256k1 attestation for the Ethereum leg.
export async function attestForEthereum(message: Hex): Promise<Hex> {
  const signer = privateKeyToAccount((await account("attester")).privateKey as Hex);
  return signer.sign({ hash: keccak256(message) });
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
  const out = await scan(qore as PublicClient, Q.messenger, state.qoreBlock, QORE_LOG_RANGE);
  for (const m of out.messages) {
    const used = await eth.readContract({ address: E.messenger, abi: messengerAbi(), functionName: "usedNonces", args: [nonceOf(m)] });
    if (used) continue;
    await send("sepolia", E.receiver, artifact("AgamaL1Receiver").abi, "relay", [m, await attestForEthereum(m)], { label: "relay to Ethereum" });
    done++;
  }
  // Rewind a little so a log the node had not indexed yet is read next time; nonces make that idempotent.
  save({ ...state, qoreBlock: Math.max(out.head - 300, state.qoreBlock) });
  if (out.error) throw out.error;

  // Ethereum to QoreChain: returns, settled by the allocator into the vault, attested post-quantum.
  const back = await scan(eth as PublicClient, E.messenger, state.ethBlock, ETH_LOG_RANGE);
  for (const m of back.messages) {
    const used = await qore.readContract({ address: Q.messenger, abi: messengerAbi(), functionName: "usedNonces", args: [nonceOf(m)] });
    if (used) continue;
    await send("qorechain", Q.allocator, artifact("CrossChainAllocator").abi, "settleReturn", [m, await attestForQoreChain(m)], {
      label: "settle on QoreChain", gas: 1_500_000n,
    });
    done++;
  }
  save({ ...load(), ethBlock: Math.max(back.head - 20, state.ethBlock) });
  if (back.error) throw back.error;
  return done;
}
