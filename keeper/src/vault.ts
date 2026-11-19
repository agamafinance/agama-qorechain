// The QoreChain side: rebalance the buffer, mark the vault to the Ethereum position with an ML-DSA-87 signed
// report, and settle the queue.
import { encodeAbiParameters, type Abi } from "viem";
import { BUFFER, E, Q, REPORT, send } from "./config.js";
import { artifact, pqAuthorize } from "./evm.js";
import { eth, qore, sleep } from "./net.js";

const AgUSDAbi = artifact("AgUSD").abi;
const AllocatorAbi = artifact("CrossChainAllocator").abi;
const ReceiverAbi = artifact("AgamaL1Receiver").abi;

type Snapshot = {
  totalAssets: bigint; totalSupply: bigint; sharePrice: bigint; idle: bigint; deployed: bigint; pending: bigint;
  unvested: bigint; liquid: bigint; depositCap: bigint; reserveBps: number; performanceFeeBps: number;
  lastReport: bigint; queueLength: bigint; paused: boolean;
};
const readQ = <T>(address: `0x${string}`, abi: Abi, functionName: string, args: unknown[] = []) =>
  qore.readContract({ address, abi, functionName, args } as any) as Promise<T>;
const readE = <T>(address: `0x${string}`, abi: Abi, functionName: string, args: unknown[] = []) =>
  eth.readContract({ address, abi, functionName, args } as any) as Promise<T>;

export const snapshot = () => readQ<Snapshot>(Q.vault, AgUSDAbi, "snapshot");

/// What the vault's deployed capital is worth: the Ethereum position plus whatever is still crossing in either
/// direction, because a burn that has not been minted yet is in flight, not lost.
///
/// Each chain is read at one block. Public endpoints are load balanced, and a `totalSent` served by a node one block
/// behind the vault's `deployedAssets` once made an allocation look lost and marked the vault down 5%.
export async function navOfBook() {
  const [qBlock, eBlock] = await Promise.all([qore.getBlockNumber(), eth.getBlockNumber()]);
  const atE = <T,>(fn: string) => eth.readContract({ address: E.receiver, abi: ReceiverAbi, functionName: fn, blockNumber: eBlock } as any) as Promise<T>;
  const atQ = <T,>(fn: string) => qore.readContract({ address: Q.allocator, abi: AllocatorAbi, functionName: fn, blockNumber: qBlock } as any) as Promise<T>;
  const [position, received, sentHome, sent, returned] = await Promise.all([
    atE<bigint>("positionValue"),
    atE<bigint>("totalReceived"),
    atE<bigint>("totalSentHome"),
    atQ<bigint>("totalSent"),
    atQ<bigint>("totalReturned"),
  ]);
  return position + (sent - received) + (sentHome - returned);
}

/// The buffer the vault must keep: its reserve floor, rounded up the way `pushToStrategy` rounds it, plus a margin.
/// Profit unlocks by the second, so total assets, and the floor with them, rise between the read here and the
/// block the allocation lands in: sized to the floor exactly, one was refused by seven micro-dollars. A cent, or
/// a basis point of the vault when that is more, covers far more than a block of unlocking.
async function floor(totalAssets: bigint) {
  const cfg = await readQ<readonly [bigint, number]>(Q.vault, AgUSDAbi, "config");
  const reserveBps = BigInt(cfg[1]);
  const margin = totalAssets / 10_000n > 10_000n ? totalAssets / 10_000n : 10_000n;
  return (totalAssets * reserveBps + 9_999n) / 10_000n + margin;
}

/// Sends everything above the reserve floor to the book.
export async function rebalance() {
  const s = await snapshot();
  const target = await floor(s.totalAssets);
  if (s.liquid > target && s.liquid - target >= BUFFER.minMove) {
    await send("qorechain", Q.allocator, AllocatorAbi, "allocate", [s.liquid - target], { gas: 1_000_000n });
    return true;
  }
  return false;
}

/// How much the buffer needs to be back at the floor, once it has fallen under half of it. Paying the queue can
/// drain it to nothing, and an empty buffer turns the next instant exit into a queued one.
export async function refill() {
  const s = await snapshot();
  const target = await floor(s.totalAssets);
  return s.liquid < target / 2n && s.deployed > 0n ? target - s.liquid : 0n;
}

/// Cash already burned on Ethereum on its way back to the vault and not yet settled there. Counted against what
/// the vault needs, so a refill whose relay is still pending is not asked for a second time.
export async function inbound() {
  const [sentHome, returned] = await Promise.all([
    readE<bigint>(E.receiver, ReceiverAbi, "totalSentHome"),
    readQ<bigint>(Q.allocator, AllocatorAbi, "totalReturned"),
  ]);
  return sentHome > returned ? sentHome - returned : 0n;
}

/// Whether the vault has something for the keeper right now: cash above the floor to send, a queue the idle cash
/// does not cover, or a buffer under half the floor. One read on QoreChain, cheap enough to ask every few seconds;
/// Ethereum is read only when the vault is short, to see whether the cash is already on its way.
export async function vaultNeedsWork() {
  const s = await snapshot();
  const target = await floor(s.totalAssets);
  if (s.liquid > target && s.liquid - target >= BUFFER.minMove) return true;
  const short = s.pending > s.idle || (s.liquid < target / 2n && s.deployed > 0n);
  return short && (await inbound()) === 0n;
}

/// How much the queue needs from the book: what is owed beyond the cash already here, plus the buffer target.
export async function shortfall() {
  const s = await snapshot();
  const idle = s.idle;
  return s.pending > idle ? s.pending - idle : 0n;
}

let lowSince: number | undefined;

export async function report() {
  const [s, cfg, navNow] = await Promise.all([
    snapshot(),
    readQ<readonly [bigint, number, number, number, number]>(Q.vault, AgUSDAbi, "config"),
    navOfBook(),
  ]);
  const [, , , maxNavChangeBps, minReportInterval] = cfg;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const every = BigInt(minReportInterval) > REPORT.everySec ? BigInt(minReportInterval) : REPORT.everySec;
  if (s.lastReport !== 0n && now < s.lastReport + every) return;
  if (s.deployed === 0n) return;
  // A mark below the book is a loss to every holder, so it has to be seen twice, a minute apart, before it is
  // reported: a real loss persists, a stale read does not.
  let nav = navNow;
  if (nav < s.deployed) {
    await sleep(60_000);
    const again = await navOfBook();
    const fresh = await snapshot();
    nav = again > nav ? again : nav;
    if (nav < fresh.deployed && (fresh.deployed - nav) * 10_000n > fresh.deployed * 50n) {
      // More than 0.5% down: report it only once it has persisted for a quarter of an hour.
      lowSince ??= Date.now();
      if (Date.now() - lowSince < 15 * 60_000) {
        console.log(`  ::warning:: book reads ${nav} under the vault's ${fresh.deployed}; reported if it persists`);
        return;
      }
    } else lowSince = undefined;
  } else lowSince = undefined;
  // A move larger than the guard is walked there in steps rather than refused.
  const max = (s.deployed * BigInt(maxNavChangeBps)) / 10_000n;
  let next = nav;
  if (nav > s.deployed + max) next = s.deployed + max;
  if (nav + max < s.deployed) next = s.deployed - max;
  if (next === s.deployed) return;
  // The reporter never sends anything: its ML-DSA-87 signature is the report, the operator relays it.
  const [deadline, sig] = await pqAuthorize(Q.vault, AgUSDAbi, "reporter", "reportNav", encodeAbiParameters([{ type: "uint256" }], [next]));
  await send("qorechain", Q.vault, AgUSDAbi, "reportNav", [next, deadline, sig], { gas: 1_200_000n, label: "reportNav (ML-DSA)" });
}

export async function settleQueue() {
  const s = await snapshot();
  if (s.queueLength > 0n && s.idle > 0n) await send("qorechain", Q.vault, AgUSDAbi, "settleRedemptions", [16n], { gas: 1_000_000n });
}
