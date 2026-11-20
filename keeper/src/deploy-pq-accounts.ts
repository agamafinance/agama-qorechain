/**
 * Deploys the PqAccountFactory and hands it the hybrid holder guard, so lenders can use Agama by signing messages
 * in QoreX: no EVM window, no grant, no gas of their own. Nothing else moves: the vault, the token, the bridge and
 * the existing lenders stay as they are.
 *
 *   tsx src/deploy-pq-accounts.ts
 */
import type { Address } from "viem";
import { account } from "./accounts.js";
import { artifact, deploy, write } from "./evm.js";
import { loadDeployments, saveDeployments } from "./deployments.js";
import { openWindow } from "./keys.js";
import { qore } from "./net.js";

const d = loadDeployments("qorechain") as Record<string, any>;
const op = (await account("operator")).evm as Address;
const guardAbi = artifact("QoreChainHybridHolderGuard").abi;
const factoryAbi = artifact("PqAccountFactory").abi;

if (!d.pqAccountFactory) {
  await openWindow(600n, 20n, false);
  await new Promise((r) => setTimeout(r, 6_000));
  d.pqAccountFactory = await deploy("qorechain", "operator", "PqAccountFactory", [op, d.hybridGuard, [d.usdc, d.access, d.vault]]);
  saveDeployments("qorechain", d);
}
const owner = (await qore.readContract({ address: d.hybridGuard, abi: guardAbi, functionName: "owner" })) as Address;
if (owner.toLowerCase() !== d.pqAccountFactory.toLowerCase()) {
  const pending = (await qore.readContract({ address: d.hybridGuard, abi: guardAbi, functionName: "pendingOwner" })) as Address;
  if (pending.toLowerCase() !== d.pqAccountFactory.toLowerCase()) {
    const r = await write("qorechain", "operator", d.hybridGuard, guardAbi, "transferOwnership", [d.pqAccountFactory]);
    console.log(`  guard.transferOwnership(factory) ${r.transactionHash}`);
  }
  const r = await write("qorechain", "operator", d.pqAccountFactory, factoryAbi, "acceptGuardOwnership");
  console.log(`  factory.acceptGuardOwnership() ${r.transactionHash}`);
}
console.log(`guard owner: ${await qore.readContract({ address: d.hybridGuard, abi: guardAbi, functionName: "owner" })}`);
await openWindow(17_280n, 1_000n, true);
