/**
 * Post-quantum keys of Agama's role accounts, and the operator's EVM window.
 *
 *   tsx src/keys.ts status
 *   tsx src/keys.ts register <role|all>     ML-DSA-87 key with proof of possession (the one classical tx allowed)
 *   tsx src/keys.ts kem <compliance|auditor|all>
 *                                           publish the role's ML-KEM-1024 key in QoreChain's KEM registry
 *   tsx src/keys.ts window [blocks] [txs]   open the operator's EVM window, scoped to Agama's contracts
 */
import { buildRegisterPqcKeyMsg, fetchEvmWindow, fetchPqcStatus, msg as qmsg, openEvmWindowMsg, signProofOfPossession } from "@qorechain/sdk";
import { evmWindowCost } from "@qorechain/evm";
import { fetchKemKey } from "@qorechain/qoreseal/network";
import { account, ROLES, sealKeys, type Role } from "./accounts.js";
import { qorBalance, sendNative } from "./native.js";
import { CHAIN_ID, REST } from "./net.js";
import { loadDeployments } from "./deployments.js";

export async function registerPqc(role: Role) {
  const acc = await account(role);
  const st = await fetchPqcStatus({ rest: REST, address: acc.cosmos });
  if (st.registered) return console.log(`${role}: ML-DSA-87 key already registered`);
  const proofOfPossession = signProofOfPossession({ chainId: CHAIN_ID, account: acc.cosmos, keypair: acc.pqc });
  const m = buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession });
  console.log(`${role}: ML-DSA-87 key registered in ${await sendNative(role, [m], "classical", 700_000)}`);
}

export async function registerKem(role: "compliance" | "auditor") {
  const acc = await account(role);
  const keys = sealKeys(role);
  const cur = await fetchKemKey({ rest: REST, address: acc.cosmos }).catch(() => ({ found: false }) as any);
  if (cur.found && Buffer.from(cur.key.publicKey).equals(Buffer.from(keys.mlkemPublicKey))) {
    return console.log(`${role}: ML-KEM-1024 key already published`);
  }
  const m = qmsg.pqc.registerKemKey({ sender: acc.cosmos, algorithmId: 2, publicKey: keys.mlkemPublicKey });
  console.log(`${role}: ML-KEM-1024 key published in ${await sendNative(role, [m], "hybrid", 600_000)}`);
}

/** The contracts the operator may call. Contract creation needs an unscoped window, opened only to deploy. */
export function windowTargets(): `0x${string}`[] {
  const d = loadDeployments("qorechain");
  return [d.usdc, d.access, d.vault, d.allocator, d.messenger, d.dataRoom].filter(Boolean);
}

export async function openWindow(blocks = 17_280n, maxTxs = 1_000n, scoped = true) {
  const acc = await account("operator");
  const targets = scoped ? windowTargets() : [];
  // Each admitted tx may consume value + gasLimit x maxFeePerGas: budget 6M gas at 250 gwei per tx.
  const maxValue = evmWindowCost({ gas: 6_000_000n, maxFeePerGas: 250_000_000_000n }) * maxTxs;
  const m = openEvmWindowMsg({
    sender: acc.cosmos, blocks, maxTxs, maxValue, ...(targets.length ? { allowedTargets: targets } : {}),
  } as Parameters<typeof openEvmWindowMsg>[0]);
  const tx = await sendNative("operator", [m], "hybrid");
  console.log(`operator: EVM window ${tx} (${blocks} blocks, ${maxTxs} txs, ${targets.length ? `scoped to ${targets.length} contracts` : "unscoped, for deployment"})`);
  return tx;
}

export async function windowStatus() {
  const acc = await account("operator");
  return fetchEvmWindow({ rest: REST, address: acc.cosmos } as any);
}

export async function status() {
  for (const role of ROLES) {
    const acc = await account(role);
    const st = await fetchPqcStatus({ rest: REST, address: acc.cosmos }).catch(() => ({ registered: false }) as any);
    const kem = await fetchKemKey({ rest: REST, address: acc.cosmos }).catch(() => ({ found: false }) as any);
    const qor = Number(await qorBalance(acc.cosmos)) / 1e6;
    console.log(`${role.padEnd(10)} ${acc.evm} ${acc.cosmos}  ${qor.toFixed(3).padStart(9)} QOR  ML-DSA ${st.registered ? "yes" : "no "}  ML-KEM ${kem.found ? "yes" : "no"}`);
  }
  console.log("operator window:", JSON.stringify(await windowStatus().catch((e) => String(e)), (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, who, ...rest] = process.argv.slice(2);
  if (cmd === "status") await status();
  else if (cmd === "register") for (const r of who === "all" ? ROLES : [who as Role]) await registerPqc(r);
  else if (cmd === "kem") for (const r of who === "all" ? (["compliance", "auditor"] as const) : [who as "compliance"]) await registerKem(r);
  else if (cmd === "window") await openWindow(BigInt(who ?? 17_280), BigInt(rest[0] ?? 1_000), rest[1] !== "unscoped");
  else console.error("usage: keys.ts status | register <role|all> | kem <compliance|auditor|all> | window [blocks] [txs] [unscoped]");
}
