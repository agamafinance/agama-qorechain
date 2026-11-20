/**
 * Agama's relayer, for lenders on their usual QoreX account.
 *
 * QoreX signs only what it can show its user, and it has no screen for MsgCrossVMCall, the message that lets a
 * QoreChain account call an EVM contract. So a lender acts in two steps, both post-quantum:
 *
 *   setup (once, until it expires)
 *     - an EVM access window, opened in QoreX (hybrid-signed MsgOpenEVMWindow): the chain refuses any EVM call made
 *       for an account without one;
 *     - an authz grant to this relayer for MsgCrossVMCall, signed in the app with QoreX (shown decoded), with an
 *       expiry;
 *   each action
 *     - the lender signs an intent with QoreX's signArbitrary: ADR-36 secp256k1 plus ML-DSA-87;
 *     - the relayer verifies it with QoreSign against the ML-DSA-87 key the lender registered on chain, checks its
 *       fields, expiry and nonce, and executes it as the lender through MsgExec: the lender's 0x twin is msg.sender,
 *       so agUSD, USDC and the application are the lender's own. The relayer pays the gas.
 *
 * It can act only inside the lender's grant (one message type, an expiry), the lender's window (blocks, count,
 * value), Agama's three contracts, and on an intent the lender signed.
 *
 *   tsx src/relayer.ts        (listens on RELAYER_PORT, default 3047; the app proxies /api/relay)
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fromBech32 } from "@cosmjs/encoding";
import { encodeFunctionData, maxUint256, toHex, type Address, type Hex } from "viem";
import { buildRegisterPqcKeyMsg, fetchPqcStatus, qorechainRegistry, signProofOfPossession } from "@qorechain/sdk";
import { fetchEvmWindow, verifyMessageWithChain } from "@qorechain/qoresign/network";
import type { MessageSignature } from "@qorechain/qoresign";
import { account } from "./accounts.js";
import { Q } from "./config.js";
import { artifact } from "./evm.js";
import { qorBalance, sendNative } from "./native.js";
import { CHAIN_ID, REST, qore, rest } from "./net.js";
import { ERC20_REGISTRY_TYPES } from "./erc20Msgs.js";

const PORT = Number(process.env.RELAYER_PORT ?? 3047);
const CROSSVM = "/qorechain.crossvm.v1.MsgCrossVMCall";
const NONCES = join(import.meta.dirname, "../secrets/relayer-nonces.json");
const registry = qorechainRegistry(ERC20_REGISTRY_TYPES as any);
const ABI = { usdc: artifact("MockUSDC").abi, vault: artifact("AgUSD").abi, access: artifact("AccessRegistry").abi };

export const ACTIONS = ["faucet", "deposit", "redeem", "requestRedeem", "settle", "publishKey", "fileDossier"] as const;
export type Action = (typeof ACTIONS)[number];
export type Intent = {
  agama: "action-v1";
  chainId: string;
  account: string;
  action: Action;
  /** deposit: USDC (6 decimals); redeem, requestRedeem: agUSD shares */
  amount?: string;
  /** publishKey: the ML-KEM-1024 public key; fileDossier: sha256 of the sealed envelope */
  data?: string;
  nonce: string;
  /** unix seconds */
  expires: number;
};

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const twinOf = (qor1: string) => toHex(fromBech32(qor1, 90).data) as Address;
const read = <T>(address: Address, abi: any, functionName: string, args: unknown[] = []) =>
  qore.readContract({ address, abi, functionName, args }) as Promise<T>;

// ---- nonces: an intent executes once ---------------------------------------------------------------------------
const nonces: Record<string, number> = existsSync(NONCES) ? JSON.parse(readFileSync(NONCES, "utf8")) : {};
function useNonce(key: string, expires: number) {
  const now = Math.floor(Date.now() / 1000);
  for (const [k, e] of Object.entries(nonces)) if (e < now) delete nonces[k];
  if (nonces[key]) throw new Error("this intent was already executed");
  nonces[key] = expires;
  writeFileSync(NONCES, JSON.stringify(nonces), { mode: 0o600 });
}

// ---- what the lender has set up -------------------------------------------------------------------------------
export async function status(qor1: string) {
  const rel = await account("relayer");
  const [g, w, pq] = await Promise.all([
    rest<any>(`/cosmos/authz/v1beta1/grants?granter=${qor1}&grantee=${rel.cosmos}`).catch(() => ({ grants: [] })),
    fetchEvmWindow({ rest: REST, address: qor1 }).catch(() => null),
    fetchPqcStatus({ rest: REST, address: qor1 }).catch(() => ({ registered: false })),
  ]);
  const grant = (g.grants ?? []).find((x: any) => x.authorization?.msg === CROSSVM && (!x.expiration || Date.parse(x.expiration) > Date.now()));
  return {
    relayer: rel.cosmos,
    grant: grant ? (grant.expiration ?? "never") : null,
    window: w ? { live: w.live, remainingTxs: String(w.remainingTxs), remainingBlocks: String(w.remainingBlocks) } : { live: false },
    pqKey: !!(pq as any).registered,
  };
}

// ---- one action ------------------------------------------------------------------------------------------------
function parseIntent(text: string): Intent {
  const i = JSON.parse(text) as Intent;
  const now = Math.floor(Date.now() / 1000);
  if (i.agama !== "action-v1" || i.chainId !== CHAIN_ID) throw new Error("not an Agama intent for qorechain-diana");
  if (!/^qor1[02-9ac-hj-np-z]{38}$/.test(i.account)) throw new Error("bad account");
  if (!ACTIONS.includes(i.action)) throw new Error("unknown action");
  if (["deposit", "redeem", "requestRedeem"].includes(i.action) && !(BigInt(i.amount ?? "0") > 0n)) throw new Error("bad amount");
  if (i.action === "publishKey" && !/^0x[0-9a-f]{3136}$/i.test(i.data ?? "")) throw new Error("bad ML-KEM-1024 key");
  if (i.action === "fileDossier" && !/^[0-9a-f]{64}$/.test(i.data ?? "")) throw new Error("bad dossier hash");
  if (typeof i.nonce !== "string" || i.nonce.length < 8 || i.nonce.length > 64) throw new Error("bad nonce");
  if (!(i.expires > now) || i.expires > now + 600) throw new Error("the intent expired, or expires more than 10 minutes ahead");
  return i;
}

const call = (sender: string, target: Address, abi: any, functionName: string, args: unknown[] = []) => ({
  typeUrl: CROSSVM,
  value: {
    sender, sourceVm: "cosmwasm", targetVm: "evm", targetContract: target,
    payload: Uint8Array.from(Buffer.from(encodeFunctionData({ abi, functionName, args }).slice(2), "hex")),
    funds: [], async: false, asyncGasLimit: "0", asyncMaxFactor: "0",
  },
});

export async function act(intentText: string, signature: MessageSignature, envelope?: Hex) {
  const i = parseIntent(intentText);
  // The lender's own hybrid signature over these exact bytes, against the ML-DSA-87 key on chain.
  await verifyMessageWithChain({ rest: REST, chainId: CHAIN_ID, signer: i.account, data: intentText, signature, requirePq: true });
  const st = await status(i.account);
  if (!st.window.live) throw new Error("Open an EVM access window in QoreX first.");
  if (!st.grant) throw new Error("Authorize Agama in the app first.");

  const me = twinOf(i.account);
  const inner: ReturnType<typeof call>[] = [];
  let gas = 900_000;
  const amount = BigInt(i.amount ?? "0");
  switch (i.action) {
    case "faucet":
      inner.push(call(i.account, Q.usdc, ABI.usdc, "faucet"));
      break;
    case "deposit":
      if ((await read<bigint>(Q.usdc, ABI.usdc, "allowance", [me, Q.vault])) < amount) inner.push(call(i.account, Q.usdc, ABI.usdc, "approve", [Q.vault, maxUint256]));
      inner.push(call(i.account, Q.vault, ABI.vault, "deposit", [amount, me]));
      gas = 700_000 + 400_000 * inner.length;
      break;
    case "redeem":
      inner.push(call(i.account, Q.vault, ABI.vault, "redeem", [amount, me, me]));
      break;
    case "requestRedeem":
      inner.push(call(i.account, Q.vault, ABI.vault, "requestRedeem", [amount, me, me]));
      gas = 1_100_000;
      break;
    case "settle":
      inner.push(call(i.account, Q.vault, ABI.vault, "settleRedemptions", [16n]));
      gas = 1_100_000;
      break;
    case "publishKey":
      inner.push(call(i.account, Q.access, ABI.access, "publishEncryptionKey", [i.data as Hex]));
      gas = 2_800_000;
      break;
    case "fileDossier": {
      if (!envelope || createHash("sha256").update(Buffer.from(envelope.slice(2), "hex")).digest("hex") !== i.data) throw new Error("the envelope is not the one signed");
      inner.push(call(i.account, Q.access, ABI.access, "fileDossier", [envelope]));
      gas = Math.max(4_800_000, 1_500_000 + Math.ceil(((envelope.length - 2) / 2) * 1_100));
      break;
    }
  }

  useNonce(`${i.account}:${i.nonce}`, i.expires);
  const digest = createHash("sha256").update(intentText).digest("hex").slice(0, 16);
  const rel = await account("relayer");
  const txHash = await sendNative(
    "relayer",
    [{ typeUrl: "/cosmos.authz.v1beta1.MsgExec", value: { grantee: rel.cosmos, msgs: inner.map((m) => ({ typeUrl: m.typeUrl, value: registry.encode(m) })) } }],
    "hybrid",
    gas,
  );
  log(`${i.action} for ${i.account}: ${txHash} (intent ${digest})`);
  return { txHash, intent: digest };
}

/** Funds the relayer from the operator when it runs low, and registers its ML-DSA-87 key once. */
export async function ensureRelayer() {
  const rel = await account("relayer");
  if ((await qorBalance(rel.cosmos)) < 5_000_000n) {
    const op = (await account("operator")).cosmos;
    const tx = await sendNative("operator", [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: op, toAddress: rel.cosmos, amount: [{ denom: "uqor", amount: "15000000" }] } }], "hybrid", 250_000);
    log(`relayer funded with 15 QOR: ${tx}`);
    await new Promise((r) => setTimeout(r, 6_000));
  }
  if (!(await fetchPqcStatus({ rest: REST, address: rel.cosmos })).registered) {
    const pop = signProofOfPossession({ chainId: CHAIN_ID, account: rel.cosmos, keypair: rel.pqc });
    const tx = await sendNative("relayer", [buildRegisterPqcKeyMsg(rel.cosmos, { pqcKeypair: rel.pqc, proofOfPossession: pop })], "classical", 700_000);
    log(`relayer ML-DSA-87 key registered: ${tx}`);
    await new Promise((r) => setTimeout(r, 6_000));
  }
  return rel.cosmos;
}

// ---- HTTP ------------------------------------------------------------------------------------------------------
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>) => (queue = queue.then(fn, fn)) as Promise<T>;

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
      if (s.length > 200_000) reject(new Error("too large"));
    });
    req.on("end", () => resolve(s));
  });
}
const reply = (res: ServerResponse, code: number, obj: unknown) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const me = await ensureRelayer();
  createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://relayer");
      if (req.method === "GET" && url.pathname === "/relay/status") {
        const a = url.searchParams.get("account") ?? "";
        if (!/^qor1[02-9ac-hj-np-z]{38}$/.test(a)) return reply(res, 400, { error: "account" });
        return reply(res, 200, await status(a));
      }
      if (req.method === "POST" && url.pathname === "/relay/act") {
        const { intent, signature, envelope } = JSON.parse(await body(req));
        return reply(res, 200, await serial(() => act(String(intent), signature, envelope)));
      }
      reply(res, 404, { error: "not found" });
    } catch (e: any) {
      log("refused:", String(e?.message ?? e).slice(0, 300));
      reply(res, 400, { error: String(e?.message ?? e).slice(0, 400) });
    }
  }).listen(PORT, () => log(`relayer ${me} listening on :${PORT}`));
}
