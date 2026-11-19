// Keeps the operator's EVM window open, scoped to Agama's contracts. QoreChain admits an EVM transaction only
// from an account with an open window (opened by a hybrid-signed native message), bounded in blocks (at most
// 17,280, about six hours on the testnet), transactions and value. Reopened before it runs out.
import { openWindow, windowStatus } from "./keys.js";

export async function ensureWindow() {
  const w = (await windowStatus()) as any;
  const live = w?.live && BigInt(w.remainingBlocks ?? 0) > 900n && BigInt(w.remainingTxs ?? 0) > 25n;
  if (live) return false;
  console.log(`  window ${w?.live ? `almost spent (${w.remainingBlocks} blocks, ${w.remainingTxs} txs left)` : "closed"}, reopening`);
  await openWindow(17_280n, 1_000n, true);
  return true;
}
