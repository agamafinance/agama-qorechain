// tsx src/cli.ts <status|tick|loop <minutes>|relay|review|tape|window|allocate <usdc>|home <usdc>>
import { formatUnits, parseUnits } from "viem";
import { E, Q, send } from "./config.js";
import { artifact } from "./evm.js";
import { eth, qore, sleep } from "./net.js";
import { relayAll } from "./relay.js";
import { bringHome, runBook } from "./book.js";
import { inbound, navOfBook, rebalance, refill, report, settleQueue, shortfall, snapshot, vaultNeedsWork } from "./vault.js";
import { reviewDossiers } from "./compliance.js";
import { publishTape } from "./dataroom.js";
import { ensureWindow } from "./window.js";
import { ensureGas } from "./gastank.js";

const usd = (v: bigint) => `$${Number(formatUnits(v, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

async function status() {
  const s = await snapshot();
  const IssuerAbi = artifact("AbfAssetIssuer").abi;
  const [cash, offChain] = (await Promise.all([
    eth.readContract({ address: E.issuer, abi: IssuerAbi, functionName: "cash" }),
    eth.readContract({ address: E.issuer, abi: IssuerAbi, functionName: "offChainAssets" }),
  ])) as [bigint, bigint];
  const [lenders, epochs, tapes] = (await Promise.all([
    qore.readContract({ address: Q.access, abi: artifact("AccessRegistry").abi, functionName: "approved" }),
    qore.readContract({ address: Q.dataRoom, abi: artifact("DataRoom").abi, functionName: "epochCount" }),
    qore.readContract({ address: Q.dataRoom, abi: artifact("DataRoom").abi, functionName: "reportCount" }),
  ])) as [readonly string[], bigint, bigint];
  console.log(`agUSD on QoreChain
  total assets   ${usd(s.totalAssets)}    supply ${formatUnits(s.totalSupply, 6)}    price ${formatUnits(s.sharePrice, 6)}
  idle           ${usd(s.idle)}    liquid ${usd(s.liquid)}    pending ${usd(s.pending)} (${s.queueLength} queued)
  deployed       ${usd(s.deployed)}    unvested ${usd(s.unvested)}
  lenders        ${lenders.length} approved    data room: ${epochs} epochs, ${tapes} tapes
ABF issuer on Ethereum Sepolia
  cash           ${usd(cash)}    book ${usd(offChain)}
  book NAV seen from QoreChain ${usd(await navOfBook())}`);
}

async function tick() {
  // Gas first: the treasury's authenticator tops the operator up within the chain's daily limit.
  await ensureGas().catch((e) => console.log(`  ::warning:: gas tank: ${(e as Error).message.split("\n")[0]}`));
  await ensureWindow();
  console.log("relay");
  await relayAll();
  // What the vault needs home is known before the book runs, so the book keeps it as cash instead of wiring it out.
  // Less whatever is already crossing back, so a refill whose relay is still pending is not asked for twice.
  const need = (await shortfall()) + (await refill());
  const coming = await inbound();
  const short = need > coming ? need - coming : 0n;
  console.log("book");
  await runBook(short);
  if (short > 0n) {
    console.log(`short ${usd(short)} for the queue and the buffer, bringing it home`);
    await bringHome(short);
  }
  console.log("rebalance");
  if (await rebalance()) {
    // Straight through: relay the allocation so the receiver subscribes it, then let the book wire it out.
    await relayAll();
    await runBook();
  }
  await relayAll();
  console.log("report");
  await report();
  await settleQueue();
  console.log("compliance");
  await reviewDossiers();
  console.log("data room");
  await publishTape();
  await status();
}

/// Is there a dossier waiting? One read, cheap enough for the watch.
async function dossiersWaiting() {
  const [w] = (await qore.readContract({
    address: Q.access, abi: artifact("AccessRegistry").abi, functionName: "pending", args: [0n, 1n],
  })) as [readonly string[], bigint];
  return w.length > 0;
}

/// Ticks for `minutes`: every three minutes, and at once whenever the vault has money to move or a dossier is
/// waiting. The watch reads QoreChain every ten seconds: its public endpoint sits behind Cloudflare, which rate
/// limits bursts. Several failed ticks in a row are an outage and end the run in error so somebody is told.
async function loop() {
  const until = Date.now() + Number(arg ?? 345) * 60_000;
  const EVERY = 180_000, WATCH = 10_000, GIVE_UP = 4;
  let failedInARow = 0;
  while (Date.now() < until) {
    const started = Date.now();
    console.log(`\n== tick ${new Date(started).toISOString()}`);
    try {
      await tick();
      failedInARow = 0;
    } catch (e) {
      failedInARow++;
      console.log(`::warning::tick failed (${failedInARow} in a row): ${(e as Error).message.split("\n")[0]}`);
      if (failedInARow >= GIVE_UP) throw e;
    }
    // A failed tick waits the full interval, so a fault the state keeps triggering cannot spin.
    while (Date.now() < Math.min(started + EVERY, until)) {
      await sleep(WATCH);
      if (failedInARow > 0) continue;
      const busy = (await vaultNeedsWork().catch(() => false)) || (await dossiersWaiting().catch(() => false));
      if (busy) {
        console.log("work waiting, ticking now");
        break;
      }
    }
  }
}

const [cmd, arg] = process.argv.slice(2);
const run: Record<string, () => Promise<unknown>> = {
  status,
  tick,
  loop,
  relay: relayAll,
  review: reviewDossiers,
  tape: () => publishTape(true),
  window: ensureWindow,
  allocate: async () => {
    await send("qorechain", Q.allocator, artifact("CrossChainAllocator").abi, "allocate", [parseUnits(arg, 6)]);
    await relayAll();
  },
  home: async () => {
    await bringHome(parseUnits(arg, 6));
    await relayAll();
  },
};
if (!run[cmd]) {
  console.error("usage: tsx src/cli.ts <status|tick|loop <minutes>|relay|review|tape|window|allocate <usdc>|home <usdc>>");
  process.exit(1);
}
await run[cmd]();
