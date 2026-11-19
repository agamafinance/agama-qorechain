/**
 * EVM side: wallet clients for the role accounts on both chains, Foundry artifacts, and ML-DSA-87 signing of the
 * exact bytes Agama's contracts check (`pqcMessage`, `attestationMessage`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createWalletClient, http, stringToHex, toHex, type Abi, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pqcSign } from "@qorechain/sdk";
import { account, type Role } from "./accounts.js";
import { diana, EVM_RPC, eth, qore, sepolia, sepoliaTransport } from "./net.js";
import { ROOT } from "./deployments.js";

export type Chain = "qorechain" | "sepolia";

export function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const a = JSON.parse(readFileSync(join(ROOT, `contracts/out/${name}.sol/${name}.json`), "utf8"));
  return { abi: a.abi, bytecode: a.bytecode.object };
}

const wallets = new Map<string, WalletClient>();
export async function wallet(role: Role, chain: Chain): Promise<WalletClient> {
  const k = `${role}:${chain}`;
  let w = wallets.get(k);
  if (!w) {
    const acc = privateKeyToAccount((await account(role)).privateKey as Hex);
    w = chain === "qorechain"
      ? createWalletClient({ account: acc, chain: diana, transport: http(EVM_RPC, { retryCount: 3, retryDelay: 2_000 }) })
      : createWalletClient({ account: acc, chain: sepolia, transport: sepoliaTransport() });
    wallets.set(k, w);
  }
  return w;
}

export const client = (chain: Chain): PublicClient => (chain === "qorechain" ? qore : eth) as PublicClient;

/** Sends a contract write from `role`, waits for it and fails loudly on a revert. */
export async function write(
  chain: Chain, role: Role, address: Address, abi: Abi, functionName: string, args: unknown[] = [], gas?: bigint,
) {
  const w = await wallet(role, chain);
  const { request } = await client(chain).simulateContract({ address, abi, functionName, args, account: w.account!, ...(gas ? { gas } : {}) } as any);
  const hash = await w.writeContract(request as any);
  const receipt = await client(chain).waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted in ${hash}`);
  return receipt;
}

export async function deploy(chain: Chain, role: Role, name: string, args: unknown[] = []): Promise<Address> {
  const { abi, bytecode } = artifact(name);
  const w = await wallet(role, chain);
  const hash = await w.deployContract({ abi, bytecode, args, account: w.account!, chain: w.chain } as any);
  const receipt = await client(chain).waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deploy ${name} failed in ${hash}`);
  console.log(`  ${chain.padEnd(9)} ${name.padEnd(22)} ${receipt.contractAddress}  gas ${receipt.gasUsed}`);
  return receipt.contractAddress;
}

/** ML-DSA-87 (FIPS 204) signature by `role` over raw bytes. */
export async function pqSign(role: Role, message: Hex): Promise<Hex> {
  const acc = await account(role);
  return toHex(pqcSign(acc.pqc.secretKey, Buffer.from(message.slice(2), "hex")));
}

export const action = (name: string) => stringToHex(name, { size: 32 });

/**
 * Signs a PqcSigned action: reads the exact message the contract will check (`pqcMessage`), signs it with
 * `signer`'s ML-DSA-87 key and returns `[deadline, signature]` to append to the call.
 */
export async function pqAuthorize(contract: Address, abi: Abi, signer: Role, actionName: string, params: Hex) {
  const signerAddr = (await account(signer)).evm as Address;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
  const nonce = (await qore.readContract({ address: contract, abi, functionName: "pqcNonce", args: [signerAddr] })) as bigint;
  const message = (await qore.readContract({
    address: contract, abi, functionName: "pqcMessage", args: [signerAddr, action(actionName), params, nonce, deadline],
  })) as Hex;
  return [deadline, await pqSign(signer, message)] as const;
}

/** Runs a post-quantum signed action on QoreChain, relayed by the operator. */
export async function pqCall(
  contract: Address, abi: Abi, fn: string, signer: Role, actionName: string, params: Hex, args: unknown[], gas = 1_500_000n,
) {
  const [deadline, sig] = await pqAuthorize(contract, abi, signer, actionName, params);
  return write("qorechain", "operator", contract, abi, fn, [...args, deadline, sig], gas);
}
