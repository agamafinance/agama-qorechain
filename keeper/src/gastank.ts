/**
 * The keeper's gas tank: the operator tops itself up with QOR from the treasury, inside limits QoreChain enforces.
 *
 * The treasury (the funding QoreX account) links an ed25519 key to itself as an authenticator, in one
 * hybrid-signed transaction, with one permission (`send`) and one spending rule (QOR only, at most 5 per payment and
 * 15 per day) that expires after 29 days (the chain allows at most 30). The keeper derives that key from the role mnemonic it already holds; the
 * treasury's own keys never reach the machine the keeper runs on. A stolen keeper can drain 15 QOR a day from the
 * treasury and nothing else, because the limits are the chain's, not the keeper's code.
 *
 *   tsx src/gastank.ts link            the treasury links the keeper's key (run where the treasury key is)
 *   tsx src/gastank.ts rules           what the chain enforces, and how much has been used
 *   tsx src/gastank.ts refuel [qor]    pay the operator from the treasury through the authenticator
 *   tsx src/gastank.ts revoke
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  buildPhantomExecuteCosmos, decodeAuthenticatorExecutions, fetchAuthenticators, fetchAuthNonce, fetchSpendingRules,
  linkAuthenticatorMsgs, revokeAuthenticatorMsg, signAuthenticatorLinkEd25519,
} from "@qorechain/sdk";
import { account, mnemonic, treasury } from "./accounts.js";
import { qorBalance, sendNative, treasuryClient } from "./native.js";
import { CHAIN_ID, REST } from "./net.js";

export const TANK = { perTxQor: 5, dailyQor: 15, days: 29, refillBelowQor: 8 };
const uqor = (qor: number) => String(Math.round(qor * 1e6));

/** The keeper's authenticator key, derived from the role mnemonic: any keeper machine can rebuild it. */
export function agentKey() {
  const sk = hkdf(sha256, new TextEncoder().encode(mnemonic()), new TextEncoder().encode("agama"), new TextEncoder().encode("gas-tank-ed25519"), 32);
  const pk = ed25519.getPublicKey(sk);
  return { sk, pk, wallet: { publicKey: pk, async signMessage(m: Uint8Array) { return { signature: ed25519.sign(m, sk) }; } } };
}

export async function treasuryAddress() {
  return (await treasury(0)).native.address;
}

export async function link() {
  const owner = await treasuryAddress();
  const k = agentKey();
  const proof = signAuthenticatorLinkEd25519({ chainId: CHAIN_ID, account: owner, privateKey: k.sk });
  const msgs = linkAuthenticatorMsgs({
    owner, chainId: CHAIN_ID, ...proof,
    permissions: ["send"],
    expiryUnix: Math.floor(Date.now() / 1000) + TANK.days * 86_400,
    label: "agama keeper gas tank",
    spendingRule: { id: "agama-gas", enabled: true, perTxLimit: uqor(TANK.perTxQor), dailyLimit: uqor(TANK.dailyQor), allowedDenoms: ["uqor"] },
  } as any);
  const { client } = await treasuryClient(0);
  const res: any = await client.signAndBroadcast(msgs, "auto", "agama: link the keeper's gas tank");
  if (res.code) throw new Error(`link refused: ${res.rawLog}`);
  console.log(`gas tank linked to ${owner}: send QOR only, ${TANK.perTxQor} per payment, ${TANK.dailyQor} per day, ${TANK.days} days  ${res.transactionHash}`);
}

export async function rules() {
  const owner = await treasuryAddress();
  const k = agentKey();
  const [r, auths, n] = await Promise.all([
    fetchSpendingRules({ rest: REST, address: owner }),
    fetchAuthenticators({ rest: REST, address: owner }),
    fetchAuthNonce({ rest: REST, address: owner, pubkey: k.pk }),
  ]);
  const me = (auths as any[]).find((a) => a.pubkeyHex.toLowerCase() === Buffer.from(k.pk).toString("hex"));
  for (const x of (r as any).rules) console.log(`rule "${x.id}" ${x.enabled ? "on" : "off"}: per payment ${Number(x.perTxLimit) / 1e6} QOR, per day ${Number(x.dailyLimit) / 1e6} QOR`);
  console.log(me ? `keeper key ${me.revoked ? "REVOKED" : "linked"}, may ${me.permissions.join(",")}, expires ${new Date(Number(me.expiryUnix) * 1000).toISOString().slice(0, 10)}, payments ${(n as any).nonce}` : "keeper key not linked");
  return !!me && !me.revoked;
}

/** Pays the operator `qor` QOR from the treasury, relayed by the operator itself. The chain checks the rule. */
export async function refuel(qor = TANK.perTxQor) {
  const owner = await treasuryAddress();
  const op = await account("operator");
  const k = agentKey();
  const { nonce } = await fetchAuthNonce({ rest: REST, address: owner, pubkey: k.pk });
  const msg = await buildPhantomExecuteCosmos({
    wallet: k.wallet, relayer: op.cosmos, chainId: CHAIN_ID, account: owner, to: op.cosmos, amount: `${uqor(qor)}uqor`, nonce,
  } as any);
  const tx = await sendNative("operator", [msg], "hybrid", 400_000);
  const t = await (await fetch(`${REST}/cosmos/tx/v1beta1/txs/${tx}`, { headers: { "user-agent": "curl/8.7.1" } })).json() as any;
  const [x] = decodeAuthenticatorExecutions({ msgResponses: t.tx_response?.msg_responses ?? [], events: t.tx_response?.events ?? [] } as any, [msg]);
  if (x && !x.success) throw new Error(`refuel refused by the chain: ${x.reason ?? "execution failed"}`);
  console.log(`  gas tank: ${qor} QOR treasury -> operator  ${tx}`);
  return tx;
}

/** Called every tick: tops the operator up when it runs low, within the chain's daily limit. */
export async function ensureGas() {
  const op = await account("operator");
  const bal = Number(await qorBalance(op.cosmos)) / 1e6;
  if (bal >= TANK.refillBelowQor) return false;
  console.log(`  operator has ${bal.toFixed(2)} QOR, refuelling from the treasury`);
  await refuel(TANK.perTxQor).catch((e) => console.log(`  ::warning:: refuel: ${(e as Error).message.split("\n")[0]}`));
  return true;
}

export async function revoke() {
  const owner = await treasuryAddress();
  const { client } = await treasuryClient(0);
  const res: any = await client.signAndBroadcast([revokeAuthenticatorMsg({ owner, scheme: "ed25519", pubkey: agentKey().pk } as any)], "auto", "agama: revoke the gas tank");
  console.log(res.code ? `refused: ${res.rawLog}` : `revoked ${res.transactionHash}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "link") await link();
  else if (cmd === "rules") await rules();
  else if (cmd === "refuel") await refuel(Number(arg ?? TANK.perTxQor));
  else if (cmd === "revoke") await revoke();
  else console.error("usage: gastank.ts link | rules | refuel [qor] | revoke");
}
