/**
 * Reading Agama's native-lane transactions. A MsgCrossVMCall executes the contract but leaves no EVM log that
 * eth_getLogs serves, so whatever the keeper, the app and the batteries used to read from events is read here from
 * the committed transaction instead: found by the indexed `crossvm_request.target_contract` event, its calldata
 * decoded from the message payload, and each fact checked against contract state before anything relies on it.
 *
 * The chain's search answers 0 for any query joining two events with AND: one event per query, filters in code.
 */
import { bytesToHex, concat, decodeFunctionData, encodeAbiParameters, keccak256, pad, parseAbi, toHex, type Abi, type Address, type Hex } from "viem";
import { account } from "./accounts.js";
import { Q } from "./config.js";
import { qore, rest } from "./net.js";

export type NativeCall = { hash: string; height: number; time: string; memo: string; sender: string; target: Address; data: Hex; gasUsed: number };

const b64ToHex = (s: string) => bytesToHex(Uint8Array.from(Buffer.from(s, "base64")));
const executed = (t: any) =>
  t.code === 0 && (t.events ?? []).some((e: any) => e.type === "crossvm_response" && e.attributes.some((a: any) => a.key === "status" && a.value === "executed"));

/** The executed MsgCrossVMCall messages of one committed transaction (tx_response with its tx), to `target`. */
export function callsIn(t: any, target?: string): NativeCall[] {
  if (!executed(t)) return [];
  return ((t.tx?.body?.messages ?? []) as any[])
    .filter((m) => m["@type"] === "/qorechain.crossvm.v1.MsgCrossVMCall" && m.payload && (!target || String(m.target_contract).toLowerCase() === target.toLowerCase()))
    .map((m) => ({
      hash: t.txhash,
      height: Number(t.height),
      time: t.timestamp,
      memo: String(t.tx?.body?.memo ?? ""),
      sender: m.sender,
      target: m.target_contract as Address,
      data: b64ToHex(m.payload),
      gasUsed: Number(t.gas_used),
    }));
}

/** Every executed native call to `target`, oldest first. Paginated: a page holds at most 100 transactions. */
export async function nativeCalls(target: Address, fromHeight = 0): Promise<NativeCall[]> {
  const out: NativeCall[] = [];
  const query = `crossvm_request.target_contract='${target.toLowerCase()}'`;
  for (let page = 1; page <= 50; page++) {
    const qs = new URLSearchParams({ query, order_by: "ORDER_BY_DESC", "pagination.limit": "100", page: String(page) });
    const r = await rest<any>(`/cosmos/tx/v1beta1/txs?${qs}`);
    const txs: any[] = r.tx_responses ?? [];
    for (const t of txs) if (Number(t.height) >= fromHeight) out.push(...callsIn(t, target));
    const total = Number(r.total ?? r.pagination?.total ?? 0);
    if (!txs.length || page * 100 >= total || txs.some((t) => Number(t.height) < fromHeight)) break;
  }
  return out.sort((a, b) => a.height - b.height);
}

/** The native calls in one block: for readers that know the block from contract state (DataRoom.partOf, reports). */
export async function callsAt(height: number | bigint, target: Address): Promise<NativeCall[]> {
  const r = await rest<any>(`/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(`tx.height=${height}`)}`).catch(() => null);
  return ((r?.tx_responses ?? []) as any[]).flatMap((t) => callsIn(t, target));
}

/** Decodes a native call against `abi`, or null if it is another function. */
export function decode<T = any>(c: NativeCall, abi: Abi, name: string): T | null {
  try {
    const d = decodeFunctionData({ abi, data: c.data });
    return d.functionName === name ? (d.args as T) : null;
  } catch {
    return null;
  }
}

// ---- the bridge: QoreChain -> Ethereum messages of native allocations --------------------------------------------

const allocatorAbi = parseAbi(["function allocate(uint256 amount)", "function remoteDomain() view returns (uint32)", "function remoteReceiver() view returns (bytes32)"]);
const messengerAbi = parseAbi([
  "function sent() view returns (uint64)",
  "function localDomain() view returns (uint32)",
  "function remoteMessenger(uint32) view returns (bytes32)",
]);
const u32 = (n: number) => pad(toHex(n), { size: 4 });
const word = (n: bigint) => pad(toHex(n), { size: 32 });
const addr32 = (a: Address) => pad(a, { size: 32 }).toLowerCase() as Hex;

/**
 * The CCTP V2 message an allocation emitted, rebuilt byte for byte (AttestedMessenger._burn): everything in it is the
 * calldata's amount, the messenger's send counter, and configuration the contracts expose. The counter is read at
 * the block before and the block of the transaction: it must have moved by exactly one, so this transaction is the
 * only send of its block and the message index is certain.
 */
export async function allocationMessage(c: NativeCall): Promise<Hex | null> {
  const args = decode<[bigint]>(c, allocatorAbi, "allocate");
  if (!args) return null;
  const read = (fn: "sent" | "localDomain", block: bigint) => qore.readContract({ address: Q.messenger, abi: messengerAbi, functionName: fn, blockNumber: block } as any) as Promise<any>;
  const h = BigInt(c.height);
  const [before, after] = (await Promise.all([read("sent", h - 1n), read("sent", h)])) as [bigint, bigint];
  if (after - before !== 1n) {
    console.log(`  ::warning:: allocation ${c.hash.slice(0, 10)}: the messenger sent ${after - before} messages in block ${h}; not rebuilt`);
    return null;
  }
  const at = { blockNumber: h } as const;
  const [localDomain, destination, receiver] = await Promise.all([
    read("localDomain", h) as Promise<number>,
    qore.readContract({ address: Q.allocator, abi: allocatorAbi, functionName: "remoteDomain", ...at }) as Promise<number>,
    qore.readContract({ address: Q.allocator, abi: allocatorAbi, functionName: "remoteReceiver", ...at }) as Promise<Hex>,
  ]);
  const remote = (await qore.readContract({ address: Q.messenger, abi: messengerAbi, functionName: "remoteMessenger", args: [destination], ...at })) as Hex;
  const chainId = BigInt(await qore.getChainId());
  // The QoreChain messenger was deployed before FINDINGS 17 added its own address to the nonce: it still runs
  // keccak256(abi.encode(chainid, localDomain, ++sent)). A messenger deployed since includes its address.
  const nonce = Q.messengerNonceHasAddress
    ? keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "uint32" }, { type: "uint64" }], [chainId, Q.messenger, localDomain, after]))
    : keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint32" }, { type: "uint64" }], [chainId, localDomain, after]));
  const body = concat([u32(1), addr32(Q.usdc), receiver, word(args[0]), addr32(Q.allocator), word(0n), word(0n), word(0n), encodeAbiParameters([{ type: "uint8" }], [1])]);
  return concat([u32(1), u32(localDomain), u32(destination), nonce, addr32(Q.messenger), remote, receiver, u32(2000), u32(0), body]);
}

/** The messages of the operator's native allocations since `fromHeight`, for the relayer and the attester. */
export async function nativeAllocationMessages(fromHeight: number): Promise<{ message: Hex; hash: string; height: number }[]> {
  const operator = (await account("operator")).cosmos;
  const calls = (await nativeCalls(Q.allocator, fromHeight)).filter((c) => c.sender === operator);
  const out: { message: Hex; hash: string; height: number }[] = [];
  for (const c of calls) {
    const message = await allocationMessage(c);
    if (message) out.push({ message, hash: c.hash, height: c.height });
  }
  return out;
}


// ---- the data room and the access registry: facts the contracts committed to, read back from calldata -----------

const roomAbi = parseAbi([
  "function publishEpochPart(uint256 epoch, uint256 part, bytes distribution)",
  "function publishReport(uint256 epoch, bytes32 kind, bytes blob, bytes32 ciphertextCommitment, bytes32 plaintextCommitment, uint256 deadline, bytes signature)",
  "function partHash(uint256 epoch, uint256 part) view returns (bytes32)",
  "event EpochPart(uint256 indexed epoch, uint256 indexed part, bytes distribution)",
  "event ReportPublished(uint256 indexed index, uint256 indexed epoch, bytes32 indexed kind, bytes blob, bytes32 ciphertextCommitment, bytes32 plaintextCommitment)",
]);
const accessAbi = parseAbi([
  "function approve(address account, uint8 tier, uint64 expiresAt, bytes32 dossierHash, bytes letter, uint256 deadline, bytes signature)",
  "function reject(address account, bytes32 dossierHash, bytes letter, uint256 deadline, bytes signature)",
  "event Approved(address indexed account, uint8 tier, uint64 expiresAt, bytes32 dossierHash, bytes letter)",
  "event Rejected(address indexed account, bytes32 dossierHash, bytes letter)",
]);

/**
 * Part `part` of epoch `epoch`'s sealed key, posted in block `at` (DataRoom.partBlock): from the EpochPart log when
 * it was sent on the EVM lane, else from the native transaction's calldata. Either way its keccak256 must be the
 * part hash the manager signed into the epoch.
 */
export async function epochPart(epoch: bigint, part: bigint, at: bigint): Promise<Hex | null> {
  const signed = (await qore.readContract({ address: Q.dataRoom, abi: roomAbi, functionName: "partHash", args: [epoch, part] })) as Hex;
  const logs = await qore.getLogs({ address: Q.dataRoom, event: roomAbi[3], args: { epoch, part }, fromBlock: at, toBlock: at }).catch(() => []);
  const candidates: Hex[] = logs.map((l: any) => l.args.distribution as Hex);
  for (const c of await callsAt(at, Q.dataRoom)) {
    const a = decode<[bigint, bigint, Hex]>(c, roomAbi as unknown as Abi, "publishEpochPart");
    if (a && a[0] === epoch && a[1] === part) candidates.push(a[2]);
  }
  return candidates.find((d) => keccak256(d) === signed) ?? null;
}

/** The sealed blob of report `index`, published in block `at`: log first, else calldata; its commitment is checked by the reader that opens it. */
export async function reportBlob(index: bigint, at: bigint, ciphertextCommitment: Hex): Promise<{ blob: Hex; tx: string } | null> {
  const logs = await qore.getLogs({ address: Q.dataRoom, event: roomAbi[4], args: { index }, fromBlock: at, toBlock: at }).catch(() => []);
  const l: any = logs.at(-1);
  if (l) return { blob: l.args.blob, tx: l.transactionHash };
  for (const c of await callsAt(at, Q.dataRoom)) {
    const a = decode<[bigint, Hex, Hex, Hex, Hex, bigint, Hex]>(c, roomAbi as unknown as Abi, "publishReport");
    if (a && a[3] === ciphertextCommitment) return { blob: a[2], tx: c.hash };
  }
  return null;
}

/**
 * The sealed decision letter on `account`, decided in block `at` (AccessRegistry.members(...).decidedBlock): log
 * first, else the calldata of the compliance officer's call, which the chain only accepted with the officer's ML-DSA-87
 * signature over keccak256(letter). Its dossier hash must be the member's.
 */
export async function decisionLetter(account: Address, at: bigint, approved: boolean, dossierHash: Hex): Promise<{ letter: Hex; tx: string } | null> {
  const ev = approved ? accessAbi[2] : accessAbi[3];
  const logs = await qore.getLogs({ address: Q.access, event: ev as any, args: { account } as any, fromBlock: at, toBlock: at }).catch(() => []);
  const l: any = logs.at(-1);
  if (l) return { letter: l.args.letter, tx: l.transactionHash };
  for (const c of (await callsAt(at, Q.access)).reverse()) {
    if (approved) {
      const a = decode<[Address, number, bigint, Hex, Hex]>(c, accessAbi as unknown as Abi, "approve");
      if (a && a[0].toLowerCase() === account.toLowerCase() && a[3] === dossierHash) return { letter: a[4], tx: c.hash };
    } else {
      const a = decode<[Address, Hex, Hex]>(c, accessAbi as unknown as Abi, "reject");
      if (a && a[0].toLowerCase() === account.toLowerCase() && a[1] === dossierHash) return { letter: a[2], tx: c.hash };
    }
  }
  return null;
}
