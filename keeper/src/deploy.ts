/**
 * Deploys and wires both legs of the route, idempotently: every step is recorded in deployments/*.json as soon as
 * it lands, and a rerun skips what is already there.
 *
 *   QoreChain (EVM 9800)                          Ethereum Sepolia
 *   MockUSDC, AccessRegistry, AgUSD,              MockUSDC, EcdsaAttestedMessenger,
 *   PqAttestedMessenger, CrossChainAllocator,     AbfAssetIssuer, AgamaL1Receiver
 *   DataRoom
 *
 * Contract creation needs the operator's EVM window open without a scope (`keys.ts window 600 40 unscoped`); the
 * keeper's own window is then scoped to the addresses deployed here (`keys.ts window`).
 *
 *   tsx src/deploy.ts
 */
import { encodeAbiParameters, keccak256, pad, toHex, type Address } from "viem";
import { account } from "./accounts.js";
import { loadDeployments, saveDeployments } from "./deployments.js";
import { artifact, deploy, pqCall, write } from "./evm.js";
import { eth, qore } from "./net.js";

export const DOMAIN = { ethereum: 0, qorechain: 9800 } as const;
const b32 = (a: Address) => pad(a, { size: 32 });

const op = (await account("operator")).evm as Address;
const reporter = (await account("reporter")).evm as Address;
const compliance = (await account("compliance")).evm as Address;
const attester = (await account("attester")).evm as Address;

const q = loadDeployments("qorechain");
const e = loadDeployments("sepolia");
const saveQ = () => saveDeployments("qorechain", q);
const saveE = () => saveDeployments("sepolia", e);

async function once(rec: Record<string, any>, key: string, save: () => void, fn: () => Promise<any>) {
  if (rec[key]) return rec[key];
  rec[key] = await fn();
  save();
  return rec[key];
}

const MINTER = keccak256(toHex("MINTER_ROLE"));
const usdcAbi = artifact("MockUSDC").abi;

// ---- QoreChain, part 1: everything the Ethereum receiver needs to name ----
q.chainId = 9800;
q.domain = DOMAIN.qorechain;
q.roles = { operator: op, admin: op, reporter, compliance, attester, guardian: op, auditor: (await account("auditor")).evm };
q.deployedAtBlock ??= Number(await qore.getBlockNumber());
saveQ();

await once(q, "usdc", saveQ, () => deploy("qorechain", "operator", "MockUSDC", [op]));
await once(q, "access", saveQ, () => deploy("qorechain", "operator", "AccessRegistry", [op, compliance]));
await once(q, "vault", saveQ, () =>
  deploy("qorechain", "operator", "AgUSD", [
    q.usdc, q.access, op, reporter, op,
    {
      depositCap: 5_000_000_000_000n,
      reserveBps: 1_000,
      performanceFeeBps: 1_000,
      maxNavChangeBps: 500,
      minReportInterval: 600,
      profitVestingPeriod: 6 * 3600,
      feeRecipient: op,
    },
  ]));
await once(q, "messenger", saveQ, () => deploy("qorechain", "operator", "PqAttestedMessenger", [DOMAIN.qorechain, q.usdc, attester, op]));
await once(q, "allocator", saveQ, () =>
  deploy("qorechain", "operator", "CrossChainAllocator", [q.vault, q.messenger, q.messenger, DOMAIN.ethereum, op, op]));
await once(q, "dataRoom", saveQ, () => deploy("qorechain", "operator", "DataRoom", [q.access, op, compliance]));

// ---- Ethereum Sepolia ----
e.chainId = 11155111;
e.domain = DOMAIN.ethereum;
e.deployedAtBlock ??= Number(await eth.getBlockNumber());
e.custody = op; // TESTNET: the SPV's bank account, stood in for by the operator's key
saveE();
await once(e, "usdc", saveE, () => deploy("sepolia", "operator", "MockUSDC", [op]));
await once(e, "messenger", saveE, () => deploy("sepolia", "operator", "EcdsaAttestedMessenger", [DOMAIN.ethereum, e.usdc, attester, op]));
await once(e, "issuer", saveE, () => deploy("sepolia", "operator", "AbfAssetIssuer", [e.usdc, op, op, 9_000]));
await once(e, "receiver", saveE, () =>
  deploy("sepolia", "operator", "AgamaL1Receiver", [e.usdc, e.messenger, e.messenger, e.issuer, DOMAIN.qorechain, b32(q.allocator), op]));

e.wired ??= {};
const stepE = (k: string, fn: () => Promise<unknown>) => once(e.wired, k, saveE, async () => (await fn(), true));
await stepE("usdcMinterMessenger", () => write("sepolia", "operator", e.usdc, usdcAbi, "grantRole", [MINTER, e.messenger]));
await stepE("usdcMinterCustody", () => write("sepolia", "operator", e.usdc, usdcAbi, "grantRole", [MINTER, op]));
await stepE("issuerAllowsReceiver", () => write("sepolia", "operator", e.issuer, artifact("AbfAssetIssuer").abi, "setAllowlisted", [e.receiver, true]));
await stepE("custodyApprovesIssuer", () => write("sepolia", "operator", e.usdc, usdcAbi, "approve", [e.issuer, 2n ** 256n - 1n]));
await stepE("messengerRemote", () =>
  write("sepolia", "operator", e.messenger, artifact("EcdsaAttestedMessenger").abi, "setRemote", [DOMAIN.qorechain, b32(q.messenger), b32(q.usdc)]));

// ---- QoreChain, part 2: wiring, every admin step signed with ML-DSA-87 ----
q.wired ??= {};
const stepQ = (k: string, fn: () => Promise<unknown>) => once(q.wired, k, saveQ, async () => (await fn(), true));
const enc = (types: string[], values: unknown[]) => encodeAbiParameters(types.map((type) => ({ type })), values as any);

await stepQ("usdcMinterMessenger", () => write("qorechain", "operator", q.usdc, usdcAbi, "grantRole", [MINTER, q.messenger]));
const vaultAbi = artifact("AgUSD").abi;
await stepQ("vaultRoles", () =>
  pqCall(q.vault, vaultAbi, "setRoles", "operator", "setRoles", enc(["address", "address", "address"], [reporter, op, q.allocator]), [reporter, op, q.allocator]));
await stepQ("vaultExemptFees", () =>
  pqCall(q.vault, vaultAbi, "setExempt", "operator", "setExempt", enc(["address", "bool"], [op, true]), [op, true]));
await stepQ("messengerRemote", () =>
  pqCall(q.messenger, artifact("PqAttestedMessenger").abi, "setRemote", "operator", "setRemote",
    enc(["uint32", "bytes32", "bytes32"], [DOMAIN.ethereum, b32(e.messenger), b32(e.usdc)]), [DOMAIN.ethereum, b32(e.messenger), b32(e.usdc)]));
await stepQ("allocatorReceiver", () =>
  pqCall(q.allocator, artifact("CrossChainAllocator").abi, "setRemoteReceiver", "operator", "setRemoteReceiver",
    enc(["bytes32"], [b32(e.receiver)]), [b32(e.receiver)]));

console.log("\nQoreChain", JSON.stringify(q, null, 2), "\nSepolia", JSON.stringify(e, null, 2));
