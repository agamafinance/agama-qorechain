/**
 * PqAccounts end to end on the testnet, signing exactly as QoreX does (message-signing-v1: ADR-36 + ML-DSA-87): a
 * brand-new QoreX-style account, with an ML-DSA-87 key and nothing else (no QOR spent by it, no EVM window, no
 * grant), takes test USDC, publishes its encryption key; then a replay, a tampered call and another key's signature
 * are refused.
 *
 *   tsx src/pq-check.ts [index=12]
 */
import { fromBech32 } from "@cosmjs/encoding";
import { encodeFunctionData, toHex, type Address } from "viem";
import { deriveCanonicalPqKey, deriveClassicalKey, signMessage } from "@qorechain/qoresign";
import { funderMnemonic, treasury } from "./accounts.js";
import { Q } from "./config.js";
import { artifact } from "./evm.js";
import { qorBalance } from "./native.js";
import { fetchEvmWindow } from "@qorechain/qoresign/network";
import { REST, qore } from "./net.js";
import { ensureRelayer } from "./relayer.js";
import { accountOf, nonceOf, submit, textFor, type Call } from "./pqaccounts.js";

await ensureRelayer();
const index = Number(process.argv[2] ?? 12);
const t = await treasury(index);
const m = funderMnemonic();
const owner = toHex(fromBech32(t.native.address, 90).data) as Address;
const sign = (text: string, i = index, addr = t.native.address) =>
  signMessage({ chainId: "qorechain-diana", signer: addr, data: text, classicalKey: deriveClassicalKey({ mnemonic: m, index: i }), pqKey: deriveCanonicalPqKey({ mnemonic: m, address: addr } as any) }) as any;

const qorBefore = await qorBalance(t.native.address);
const acc = await accountOf(owner);
console.log(`owner ${t.native.address} (${owner}) -> PqAccount ${acc}`);
let ok = 0, n = 0;
const check = (c: boolean, label: string) => (n++, c && ok++, console.log(`${c ? "PASS" : "FAIL"}  ${label}`));
const usdcAbi = artifact("MockUSDC").abi;
const bal = () => qore.readContract({ address: Q.usdc, abi: usdcAbi, functionName: "balanceOf", args: [acc] }) as Promise<bigint>;

async function run(calls: Call[], summary: string) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const text = textFor(acc, calls, summary, await nonceOf(acc), deadline);
  const signature = sign(text);
  return { r: await submit({ owner, calls, summary, deadline: String(deadline), signature }), text, signature, deadline };
}

const before = await bal();
const faucet: Call[] = [{ target: Q.usdc, data: encodeFunctionData({ abi: usdcAbi, functionName: "faucet" }) }];
const f = await run(faucet, "Get 10,000 test USDC");
check((await bal()) === before + 10_000_000_000n, `faucet through the PqAccount, ML-DSA-87 checked on chain: ${f.r.txHash} (gas ${f.r.gasUsed})`);

const key = toHex(new Uint8Array(1568).fill(7));
const k = await run([{ target: Q.access, data: encodeFunctionData({ abi: artifact("AccessRegistry").abi, functionName: "publishEncryptionKey", args: [key] }) }], "Publish your encryption key");
const onChain = (await qore.readContract({ address: Q.access, abi: artifact("AccessRegistry").abi, functionName: "encryptionKey", args: [acc] })) as string;
check(onChain === key, `encryption key bound to the PqAccount in the registry: ${k.r.txHash}`);

const refuse = async (label: string, fn: () => Promise<unknown>) => {
  try {
    await fn();
    check(false, `${label}: accepted`);
  } catch (e: any) {
    check(true, `${label}: refused (${String(e?.shortMessage ?? e?.message ?? e).split("\n")[0].slice(0, 90)})`);
  }
};
await refuse("replay of the first message", () => submit({ owner, calls: faucet, summary: "Get 10,000 test USDC", deadline: String(f.deadline), signature: f.signature }));
const d2 = BigInt(Math.floor(Date.now() / 1000) + 300);
const signedApprove: Call[] = [{ target: Q.usdc, data: encodeFunctionData({ abi: usdcAbi, functionName: "approve", args: [Q.vault, 1_000_000n] }) }];
const s2 = sign(textFor(acc, signedApprove, "Allow 1 USDC", await nonceOf(acc), d2));
const forged: Call[] = [{ target: Q.usdc, data: encodeFunctionData({ abi: usdcAbi, functionName: "approve", args: [Q.vault, 10n ** 30n] }) }];
await refuse("a 1 USDC approval submitted as an unlimited one", () => submit({ owner, calls: forged, summary: "Allow 1 USDC", deadline: String(d2), signature: s2 }));
const other = await treasury(index + 1);
const s3 = sign(textFor(acc, faucet, "Get 10,000 test USDC", await nonceOf(acc), d2), index + 1, other.native.address);
await refuse("another account's signature", () => submit({ owner, calls: faucet, summary: "Get 10,000 test USDC", deadline: String(d2), signature: s3 }));

// Past the relayer: the contract itself refuses the forged approval (eth_call of factory.execute).
await refuse("the forged approval sent straight to the contract, past the relayer's checks", () =>
  qore.simulateContract({ address: Q.pqAccountFactory, abi: artifact("PqAccountFactory").abi, functionName: "execute", args: [owner, forged, "Allow 1 USDC", d2, ("0x" + Buffer.from(s2.pq.signature, "base64").toString("hex")) as `0x${string}`], account: "0x000000000000000000000000000000000000dEaD" } as any));
const w: any = await fetchEvmWindow({ rest: REST, address: t.native.address }).catch(() => null);
check(!w?.live && (await qorBalance(t.native.address)) === qorBefore, `the lender opened no EVM window, signed no grant and spent no QOR (${Number(qorBefore) / 1e6} QOR before and after)`);
console.log(`\n${ok}/${n} PqAccount checks passed`);
process.exit(ok === n ? 0 : 1);
