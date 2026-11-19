// Addresses, policy and the one way the keeper sends a transaction.
import { resolve } from "node:path";
import { BaseError, ContractFunctionRevertedError, type Abi, type Address, type Hex } from "viem";
import { loadDeployments } from "./deployments.js";
import { client, wallet, type Chain } from "./evm.js";
import { sleep } from "./net.js";
import type { Role } from "./accounts.js";

export const Q = loadDeployments("qorechain") as Record<string, any> & {
  usdc: Address; access: Address; vault: Address; messenger: Address; allocator: Address; dataRoom: Address; deployedAtBlock: number;
};
export const E = loadDeployments("sepolia") as Record<string, any> & {
  usdc: Address; messenger: Address; issuer: Address; receiver: Address; custody: Address; deployedAtBlock: number;
};

/// The ABF book's simulated economics: senior asset-backed paper, 9% target. How much of the issuer is wired out
/// is the contract's `maxOffChainBps`, not a keeper setting.
export const BOOK = { aprBps: 900, markEverySec: 600n };

/// Everything above the vault's reserve floor (its `reserveBps`, read every tick) goes to the book as soon as a
/// tick sees it; cash comes home once the buffer is under half the floor. Moves under a dollar wait.
export const BUFFER = { minMove: 1_000_000n };

/// The vault is marked to the book every three hours: each mark carries a 4,627-byte ML-DSA-87 signature through
/// pqcVerify, about 300k gas of QOR, and three hours of accrual move the price by millionths.
export const REPORT = { everySec: 3n * 3_600n };

export const STATE_FILE = resolve(import.meta.dirname, "../state.json");

/// Sends from `role` and waits, and refuses to call a reverted transaction done. A send whose simulation reverts
/// is tried again a few seconds later, up to four times: public endpoints are load balanced, and the node that
/// simulates can be a block behind the one that returned the previous receipt. Nothing is broadcast when the
/// simulation reverts, so a retry cannot send twice.
export async function send(
  chain: Chain, address: Address, abi: Abi, functionName: string, args: unknown[] = [],
  opts: { role?: Role; gas?: bigint; label?: string } = {},
): Promise<Hex> {
  const role = opts.role ?? "operator";
  const label = opts.label ?? functionName;
  const w = await wallet(role, chain);
  const pub = client(chain);
  let hash: Hex | undefined;
  for (let attempt = 0; !hash; attempt++) {
    try {
      // QoreChain charges the whole gas limit, not the gas used, so the limit is the estimate plus a quarter, never a
      // round ceiling. `opts.gas` is only the fallback when a node cannot estimate.
      const est = await pub
        .estimateContractGas({ address, abi, functionName, args, account: w.account! } as any)
        .then((g) => (g * 125n) / 100n)
        .catch(() => opts.gas);
      const { request } = await pub.simulateContract({ address, abi, functionName, args, account: w.account!, ...(est ? { gas: est } : {}) } as any);
      hash = await w.writeContract(request as any);
    } catch (e) {
      const reverted = e instanceof BaseError && e.walk((c) => c instanceof ContractFunctionRevertedError);
      if (!reverted || attempt === 4) throw e;
      console.log(`  ${label} refused by a node that may be behind, retrying`);
      await sleep(chain === "sepolia" ? 12_000 : 3_000);
    }
  }
  const receipt = await pub.waitForTransactionReceipt({ hash: hash!, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`${label} reverted on chain: ${hash}`);
  console.log(`  ${chain === "qorechain" ? "qore" : "eth "} ${label.padEnd(20)} ${hash}  gas ${receipt.gasUsed}`);
  return hash!;
}
