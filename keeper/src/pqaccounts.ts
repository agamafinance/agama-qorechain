/**
 * Lenders on PqAccounts (contracts/src/account): the lender signs a plain-text message in QoreX, the relayer submits
 * it, and the lender's account checks the ML-DSA-87 signature on chain with pqcVerify before it calls Agama. The
 * relayer checks both halves first (secp256k1 and ML-DSA-87, QoreSign against the keys on chain), so it never pays
 * for a message the chain would refuse, and the chain checks the post-quantum half again whoever submits.
 */
import { createHash } from "node:crypto";
import { toBech32 } from "@cosmjs/encoding";
import { hexToBytes, keccak256, encodeAbiParameters, type Address, type Hex } from "viem";
import { openEvmWindowMsg } from "@qorechain/sdk";
import { evmWindowCost } from "@qorechain/evm";
import { fetchEvmWindow, verifyMessageWithChain } from "@qorechain/qoresign/network";
import type { MessageSignature } from "@qorechain/qoresign";
import { account } from "./accounts.js";
import { Q } from "./config.js";
import { artifact, wallet } from "./evm.js";
import { sendNative } from "./native.js";
import { CHAIN_ID, REST, qore } from "./net.js";

export type Call = { target: Address; data: Hex };
const factoryAbi = artifact("PqAccountFactory").abi;
const accountAbi = artifact("PqAccount").abi;
const callsType = [{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "data", type: "bytes" }] }] as const;

export const accountOf = (owner: Address) =>
  qore.readContract({ address: Q.pqAccountFactory, abi: factoryAbi, functionName: "accountOf", args: [owner] }) as Promise<Address>;

export async function nonceOf(acc: Address): Promise<bigint> {
  const code = await qore.getCode({ address: acc });
  if (!code || code === "0x") return 0n;
  return (await qore.readContract({ address: acc, abi: accountAbi, functionName: "nonce" })) as bigint;
}

/** The text the owner signs, exactly as PqAccount.textFor rebuilds it. */
export function textFor(acc: Address, calls: Call[], summary: string, nonce: bigint, deadline: bigint) {
  const h = keccak256(encodeAbiParameters(callsType, [calls]));
  return `${summary}\n\nAgama account ${acc.toLowerCase()}\nnonce ${nonce}\nvalid until ${deadline}\ncalls ${h}`;
}

/** Keeps the relayer's own EVM window open, scoped to the factory: the only contract it ever calls. */
export async function ensureRelayerWindow() {
  const rel = await account("relayer");
  const w: any = await fetchEvmWindow({ rest: REST, address: rel.cosmos }).catch(() => null);
  if (w?.live && Number(w.remainingBlocks) > 600 && Number(w.remainingTxs) > 20) return;
  const maxTxs = 1_000n;
  const msg = openEvmWindowMsg({
    sender: rel.cosmos, blocks: 17_280n, maxTxs, maxValue: evmWindowCost({ gas: 8_000_000n, maxFeePerGas: 250_000_000_000n }) * maxTxs,
    allowedTargets: [Q.pqAccountFactory],
  } as any);
  console.log(`relayer EVM window ${await sendNative("relayer", [msg], "hybrid", 400_000)}`);
  await new Promise((r) => setTimeout(r, 6_000));
}

const ALLOWED = () => new Set([Q.usdc, Q.access, Q.vault].map((a: string) => a.toLowerCase()));

export async function submit(req: { owner: Address; calls: Call[]; summary: string; deadline: string; signature: MessageSignature }) {
  const { owner, calls, summary } = req;
  const deadline = BigInt(req.deadline);
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new Error("bad owner");
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > 4) throw new Error("one to four calls");
  if (calls.some((c) => !ALLOWED().has(String(c.target).toLowerCase()) || !/^0x[0-9a-fA-F]*$/.test(c.data))) throw new Error("only Agama's contracts");
  if (typeof summary !== "string" || summary.length > 200) throw new Error("bad summary");
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= now || deadline > now + 900n) throw new Error("the message expired, or expires more than 15 minutes ahead");
  if (!req.signature?.pq?.signature) throw new Error("the message carries no ML-DSA-87 signature");

  const acc = await accountOf(owner);
  const nonce = await nonceOf(acc);
  const text = textFor(acc, calls, summary, nonce, deadline);
  // Both halves, against the owner's keys on chain, before the relayer spends anything.
  await verifyMessageWithChain({ rest: REST, chainId: CHAIN_ID, signer: toBech32("qor", hexToBytes(owner)), data: text, signature: req.signature, requirePq: true });

  await ensureRelayerWindow();
  const w = await wallet("relayer", "qorechain");
  const pqSignature = ("0x" + Buffer.from(req.signature.pq.signature, "base64").toString("hex")) as Hex;
  const args = [owner, calls, summary, deadline, pqSignature];
  const gas = await qore.estimateContractGas({ address: Q.pqAccountFactory, abi: factoryAbi, functionName: "execute", args, account: w.account! } as any);
  const hash = await w.writeContract({ address: Q.pqAccountFactory, abi: factoryAbi, functionName: "execute", args, account: w.account!, chain: w.chain, gas: (gas * 125n) / 100n } as any);
  const receipt = await qore.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`reverted on chain in ${hash}`);
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 16);
  console.log(new Date().toISOString(), `pq ${summary.split("\n")[0]} for ${acc} (owner ${owner}): ${hash} gas ${receipt.gasUsed} (message ${digest})`);
  return { txHash: hash, account: acc, gasUsed: String(receipt.gasUsed) };
}
