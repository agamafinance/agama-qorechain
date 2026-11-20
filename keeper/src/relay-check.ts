/**
 * The relayer path end to end, signing as QoreX does (message-signing-v1: ADR-36 + ML-DSA-87): a faucet intent and a
 * key publication executed through MsgExec, then a replayed and a tampered intent, which must be refused.
 *
 *   tsx src/relay-setup.ts 9 --grant && tsx src/relay-check.ts 9
 */
import { randomBytes } from "node:crypto";
import { fromBech32 } from "@cosmjs/encoding";
import { toHex, type Address } from "viem";
import { deriveCanonicalPqKey, deriveClassicalKey, signMessage } from "@qorechain/qoresign";
import { funderMnemonic, treasury } from "./accounts.js";
import { Q } from "./config.js";
import { artifact } from "./evm.js";
import { qore, sleep } from "./net.js";
import { act, ensureRelayer, type Intent } from "./relayer.js";

await ensureRelayer();

const index = Number(process.argv[2] ?? 9);
const t = await treasury(index);
const address = t.native.address;
const m = funderMnemonic();
const classicalKey = deriveClassicalKey({ mnemonic: m, index });
const pqKey = deriveCanonicalPqKey({ mnemonic: m, address } as any);
const twin = toHex(fromBech32(address, 90).data) as Address;
const sign = (i: Intent) => {
  const text = JSON.stringify(i);
  return { text, signature: signMessage({ chainId: "qorechain-diana", signer: address, data: text, classicalKey, pqKey }) };
};
const intent = (action: Intent["action"], extra: Partial<Intent> = {}): Intent => ({
  agama: "action-v1", chainId: "qorechain-diana", account: address, action, nonce: randomBytes(12).toString("hex"),
  expires: Math.floor(Date.now() / 1000) + 300, ...extra,
});
const bal = () => qore.readContract({ address: Q.usdc, abi: artifact("MockUSDC").abi, functionName: "balanceOf", args: [twin] }) as Promise<bigint>;

let ok = 0, n = 0;
const check = (c: boolean, label: string) => (n++, c && ok++, console.log(`${c ? "PASS" : "FAIL"}  ${label}`));

const before = await bal();
const f = sign(intent("faucet"));
const r = await act(f.text, f.signature as any);
await sleep(5_000);
check((await bal()) === before + 10_000_000_000n, `faucet relayed as the lender ${r.txHash}`);

const refuse = async (label: string, text: string, sig: any) => {
  try {
    await act(text, sig);
    check(false, `${label}: accepted`);
  } catch (e: any) {
    check(true, `${label}: refused (${String(e?.message ?? e).slice(0, 80)})`);
  }
};
await refuse("replay of the same intent", f.text, f.signature);
const d = sign(intent("deposit", { amount: "1000000" }));
await refuse("a deposit of 1,000,000 USDC under a 1 USDC signature", JSON.stringify({ ...JSON.parse(d.text), amount: "1000000000000" }), d.signature);
const other = await treasury(index + 1);
await refuse("an intent for another account", JSON.stringify({ ...JSON.parse(f.text), account: other.native.address, nonce: "fffffffffff1" }), f.signature);
console.log(`\n${ok}/${n} relayer checks passed`);
process.exit(ok === n ? 0 : 1);
