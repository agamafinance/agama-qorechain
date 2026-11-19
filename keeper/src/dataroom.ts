/**
 * The data room manager. Keeps the group of readers equal to the vault's approved lenders (plus the auditor) and
 * publishes the loan tape to them, encrypted.
 *
 *   epoch   every change in the approved set starts a new epoch: a fresh 32-byte group key sealed with
 *           ML-KEM-1024 to each member's published key and to the auditor (QoreSeal `sealEpochKey`). A lender who
 *           left cannot open the next key; one who joined cannot open the previous ones.
 *   report  the tape for the current book, encrypted under the epoch key (QoreSeal private batch: AES-256-GCM,
 *           a SHA3-256 commitment to the ciphertext and a salted one to the plaintext).
 *
 * Both are signed with the manager's ML-DSA-87 key and checked by pqcVerify on chain.
 *
 * The epoch keys are derived, not stored: HKDF-SHA-256 of the manager's QoreSeal seed and the epoch number. The
 * keeper runs on ephemeral CI machines, and a key it had to remember would be a key it could lose.
 */
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { encodeAbiParameters, keccak256, stringToHex, toHex, type Address, type Hex } from "viem";
import { sealBatch, sealEpochKey, type EpochKey } from "@qorechain/qoreseal";
import { sealKeys } from "./accounts.js";
import { E, Q, send } from "./config.js";
import { artifact, pqAuthorize } from "./evm.js";
import { eth, qore } from "./net.js";
import { bytes, officer, SEAL } from "./sealing.js";
import { loanTape } from "./tape.js";

const RoomAbi = artifact("DataRoom").abi;
const AccessAbi = artifact("AccessRegistry").abi;
const IssuerAbi = artifact("AbfAssetIssuer").abi;
const TAPE = stringToHex("loan-tape", { size: 32 });
/** A fresh tape at most this often, unless the epoch changed. */
const TAPE_EVERY_SEC = 6 * 3600;

export function epochKey(epoch: bigint): EpochKey {
  const seed = sealKeys("compliance").seed;
  const key = hkdf(sha256, seed, new TextEncoder().encode("agama-dataroom"), new TextEncoder().encode(`epoch|${epoch}`), 32);
  // QoreSeal numbers epochs from 1; the contract from 0.
  return { epoch: epoch + 1n, key };
}

type Epoch = { publishedAt: bigint; blockNumber: bigint; members: number; membersHash: Hex; distributionHash: Hex };
type Report = { epoch: bigint; publishedAt: bigint; blockNumber: bigint; size: number; ciphertextCommitment: Hex; plaintextCommitment: Hex; kind: Hex };

const read = <T>(address: Address, abi: any, functionName: string, args: unknown[] = []) =>
  qore.readContract({ address, abi, functionName, args } as any) as Promise<T>;

const membersHash = (members: Address[]) => keccak256(encodeAbiParameters([{ type: "address[]" }], [members]));

/** Starts a new epoch if the approved set differs from the current epoch's members. Returns the current epoch. */
export async function syncEpoch(): Promise<{ epoch: bigint; rotated: boolean }> {
  const members = [...(await read<Address[]>(Q.access, AccessAbi, "approved"))].sort();
  const count = await read<bigint>(Q.dataRoom, RoomAbi, "epochCount");
  if (count > 0n) {
    const last = await read<Epoch>(Q.dataRoom, RoomAbi, "epochs", [count - 1n]);
    if (last.membersHash === membersHash(members)) return { epoch: count - 1n, rotated: false };
  }
  const epoch = count;
  const recipients = [await officer("auditor")];
  for (const m of members) {
    recipients.push({ mlkemPublicKey: bytes(await read<Hex>(Q.access, AccessAbi, "encryptionKey", [m])) });
  }
  const distribution = toHex(sealEpochKey({ chainId: SEAL.chainId, purpose: SEAL.epoch, mode: SEAL.mode, epochKey: epochKey(epoch), recipients }));
  const params = encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }], [epoch, membersHash(members), keccak256(distribution)]);
  const [deadline, sig] = await pqAuthorize(Q.dataRoom, RoomAbi, "compliance", "publishEpoch", params);
  await send("qorechain", Q.dataRoom, RoomAbi, "publishEpoch", [epoch, members, distribution, deadline, sig], {
    gas: 3_000_000n, label: `epoch ${epoch} (${members.length} lenders)`,
  });
  return { epoch, rotated: true };
}

/** Publishes the loan tape under the current epoch when it is due. */
export async function publishTape(force = false): Promise<boolean> {
  const { epoch, rotated } = await syncEpoch();
  const n = await read<bigint>(Q.dataRoom, RoomAbi, "reportCount");
  if (!force && !rotated && n > 0n) {
    const [last] = await read<Report[]>(Q.dataRoom, RoomAbi, "latestReports", [1n]);
    if (last.epoch === epoch && Date.now() / 1000 < Number(last.publishedAt) + TAPE_EVERY_SEC) return false;
  }
  const book = (await eth.readContract({ address: E.issuer, abi: IssuerAbi, functionName: "offChainAssets" })) as bigint;
  const tape = loanTape(book, Math.floor(Date.now() / 1000));
  const sealed = sealBatch({ epochKey: epochKey(epoch), context: SEAL.tapeContext, batchIndex: n, data: new TextEncoder().encode(JSON.stringify(tape)) });
  const blob = toHex(sealed.blob);
  const ct = toHex(sealed.ciphertextCommitment), pt = toHex(sealed.plaintextCommitment);
  const params = encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [epoch, TAPE, keccak256(blob), ct, pt],
  );
  const [deadline, sig] = await pqAuthorize(Q.dataRoom, RoomAbi, "compliance", "publishReport", params);
  await send("qorechain", Q.dataRoom, RoomAbi, "publishReport", [epoch, TAPE, blob, ct, pt, deadline, sig], {
    gas: 2_500_000n, label: `loan tape #${n} (epoch ${epoch})`,
  });
  return true;
}
