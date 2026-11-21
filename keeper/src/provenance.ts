/**
 * Where a dossier came from, checked the way a custodian checks a deposit: the compliance officer finds the native
 * transaction that filed it and verifies both of its signatures with QoreSign, the secp256k1 one against the key in
 * the transaction and the ML-DSA-87 one against the key the account registered on chain. Only then does it read
 * the dossier. A dossier the chain accepted always passes (the chain runs the same check); doing it again here
 * means the officer's decision does not rest on trusting the node it reads from.
 */
import { fromBech32, toBech32 } from "@cosmjs/encoding";
import { decodeFunctionData, hexToBytes, keccak256, parseAbi, parseAbiItem, toHex, type Address, type Hex } from "viem";
import { qore } from "./net.js";
import { verifyHybridTx } from "@qorechain/qoresign";
import { artifact } from "./evm.js";
import { CHAIN_ID, RPC, rest } from "./net.js";

export type Provenance = { tx: string; signer: string; classical: boolean; postQuantum: boolean; lane?: "native" | "evm" | "relayed" | "pq-account" };

const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));
export const bech32Of = (twin: Address) => toBech32("qor", hexToBytes(twin));
export const twinOf = (qor1: string) => toHex(fromBech32(qor1, 90).data) as Address;

/** The hybrid-verified transaction that filed `dossierHash` for `account`, or null when none is found. */
export async function dossierProvenance(access: Address, account: Address, dossierHash: Hex): Promise<Provenance | null> {
  const signer = bech32Of(account);
  const q = encodeURIComponent(`crossvm_request.target_contract='${access.toLowerCase()}'`);
  const found = await rest<{ tx_responses?: any[] }>(`/cosmos/tx/v1beta1/txs?query=${q}&order_by=ORDER_BY_DESC&pagination.limit=50`);
  const abi = artifact("AccessRegistry").abi;
  for (const t of found.tx_responses ?? []) {
    if (t.code) continue;
    // Filed by the lender itself, or by Agama's relayer as the lender (authz MsgExec, on an intent the lender signed).
    const flat = (t.tx.body.messages as any[]).flatMap((m) => (m["@type"] === "/cosmos.authz.v1beta1.MsgExec" ? (m.msgs ?? []).map((x: any) => ({ ...x, relayedBy: m.grantee })) : [m]));
    let relayedBy: string | undefined;
    const hit = flat.some((m) => {
      if (m["@type"] !== "/qorechain.crossvm.v1.MsgCrossVMCall" || m.sender !== signer) return false;
      relayedBy = m.relayedBy;
      try {
        const call = decodeFunctionData({ abi, data: toHex(b64(m.payload)) });
        return call.functionName === "fileDossier" && keccak256(call.args![0] as Hex) === dossierHash;
      } catch {
        return false;
      }
    });
    if (!hit) continue;

    if (relayedBy) {
      // The relayer's transaction, both signatures verified; the lender's own intent signature was verified against
      // its on-chain ML-DSA-87 key before the relayer sent anything, and only a lender with a registered key gets there.
      const res = await verifyTx(t.txhash, t.tx.auth_info.signer_infos[0].public_key, relayedBy);
      const pq = await rest<any>(`/qorechain/pqc/v1/account/${signer}`).catch(() => null);
      return { tx: t.txhash, signer, classical: res.classical, postQuantum: res.postQuantum && !!pq?.account?.public_key, lane: "relayed" };
    }
    const res = await verifyTx(t.txhash, t.tx.auth_info.signer_infos[0].public_key, signer);
    return { tx: t.txhash, signer, ...res, lane: "native" };
  }
  return (await pqAccountNativeProvenance(access, account, dossierHash)) ?? evmProvenance(access, account, dossierHash);
}

/**
 * A dossier filed by a PqAccount on the native lane: Agama's relayer sent factory.execute as a hybrid-signed
 * MsgCrossVMCall, which leaves no EVM log. The officer finds that transaction (indexed by its target, the factory),
 * verifies its two signatures with QoreSign, then verifies the owner's ML-DSA-87 signature itself: the text QoreX
 * signed is rebuilt from the calldata, and the nonce it was signed for is found below the account's current one (only
 * one verifies). The owner's key must be registered with proof of possession.
 */
async function pqAccountNativeProvenance(access: Address, account: Address, dossierHash: Hex): Promise<Provenance | null> {
  const { Q } = await import("./config.js");
  const { nativeCalls, decode } = await import("./chain.js");
  if (!Q.pqAccountFactory) return null;
  const head = Number(await qore.getBlockNumber());
  const accessAbi = artifact("AccessRegistry").abi;
  for (const c of (await nativeCalls(Q.pqAccountFactory, head - 20_000)).reverse()) {
    const a = decode<[Address, readonly { target: Address; data: Hex }[], string, bigint, Hex]>(c, factoryExecAbi, "execute");
    if (!a) continue;
    const [owner, calls, summary, deadline, sig] = a;
    const acc = (await qore.readContract({ address: Q.pqAccountFactory, abi: factoryExecAbi, functionName: "accountOf", args: [owner] })) as Address;
    if (acc.toLowerCase() !== account.toLowerCase()) continue;
    const files = calls.some((x) => {
      if (x.target.toLowerCase() !== access.toLowerCase()) return false;
      try {
        const d = decodeFunctionData({ abi: accessAbi, data: x.data });
        return d.functionName === "fileDossier" && keccak256(d.args![0] as Hex) === dossierHash;
      } catch {
        return false;
      }
    });
    if (!files) continue;
    const t = await rest<any>(`/cosmos/tx/v1beta1/txs/${c.hash}`);
    const res = await verifyTx(c.hash, t.tx.auth_info.signer_infos[0].public_key, c.sender);
    const owned = await verifyOwnerSignature(acc, owner, calls, summary, deadline, sig);
    return { tx: c.hash, signer: bech32Of(owner), classical: res.classical && res.postQuantum, postQuantum: owned.verified && owned.proven, lane: "pq-account" };
  }
  return null;
}

const factoryExecAbi = parseAbi([
  "function execute(address owner, (address target, bytes data)[] calls, string summary, uint256 deadline, bytes pqSignature)",
  "function accountOf(address owner) view returns (address)",
]);

/**
 * The owner's ML-DSA-87 signature on a PqAccount execution, verified here against the key it registered on chain:
 * over "qorechain-msg-v1|qorechain-diana|" + the text PqAccount.textFor builds. The nonce is not in the calldata; the
 * account's has moved past it, so it is the one below the current nonce the signature verifies for, and no other.
 */
export async function verifyOwnerSignature(account: Address, owner: Address, calls: readonly { target: Address; data: Hex }[], summary: string, deadline: bigint, sig: Hex) {
  const { mldsa87 } = await import("@qorechain/pqc");
  const { textFor } = await import("./pqaccounts.js");
  const [registered, , key, proven] = (await qore.readContract({
    address: "0x0000000000000000000000000000000000000a02",
    abi: [{ type: "function", name: "pqcKeyStatus", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }, { type: "uint8" }, { type: "bytes" }, { type: "bool" }] }],
    functionName: "pqcKeyStatus", args: [owner],
  })) as readonly [boolean, number, Hex, boolean];
  if (!registered) return { verified: false, proven: false, nonce: -1n, matches: 0 };
  const current = (await qore.readContract({ address: account, abi: parseAbi(["function nonce() view returns (uint256)"]), functionName: "nonce" })) as bigint;
  const signed = (n: bigint) => new TextEncoder().encode(`qorechain-msg-v1|${CHAIN_ID}|` + textFor(account, calls as any, summary, n, deadline));
  const pk = hexToBytes(key);
  const s = hexToBytes(sig);
  const hits: bigint[] = [];
  for (let n = current - 1n; n >= 0n && n >= current - 400n; n--) if (mldsa87.verify(pk, signed(n), s)) hits.push(n);
  return { verified: hits.length === 1, proven, nonce: hits[0] ?? -1n, matches: hits.length };
}

/**
 * A dossier filed from QoreX's EVM provider (the path QoreX 0.4 supports): an EVM transaction, admitted by QoreChain
 * only inside an EVM window that the account opened with a hybrid (secp256k1 + ML-DSA-87) signature, from an
 * account whose ML-DSA-87 key is registered with proof of possession. The officer finds the filing in the registry's
 * logs and checks the account's key status on chain.
 */
async function evmProvenance(access: Address, account: Address, dossierHash: Hex): Promise<Provenance | null> {
  const head = await qore.getBlockNumber();
  const logs = await qore.getLogs({
    address: access, event: parseAbiItem("event DossierFiled(address indexed account, bytes32 dossierHash, uint256 size)"),
    args: { account }, fromBlock: head > 9_000n ? head - 9_000n : 0n, toBlock: head,
  });
  const hit = logs.reverse().find((l) => l.args.dossierHash === dossierHash);
  if (!hit) return null;
  // Filed by a PqAccount: the account checked its owner's ML-DSA-87 signature on chain (pqcVerify) in this very
  // transaction, which its Executed event proves; the owner's key must be registered with proof of possession.
  const factory = (await import("./config.js")).Q.pqAccountFactory as Address | undefined;
  if (factory) {
    const owner = (await qore.readContract({ address: factory, abi: parseAbi(["function ownerOf(address) view returns (address)"]), functionName: "ownerOf", args: [account] })) as Address;
    if (owner !== "0x0000000000000000000000000000000000000000") {
      const receipt = await qore.getTransactionReceipt({ hash: hit.transactionHash! });
      const executed = receipt.status === "success" && receipt.logs.some((l) => l.address.toLowerCase() === account.toLowerCase() && l.topics[0] === keccak256(toHex("Executed(uint256,bytes32,address,uint256)")));
      const [registered, , , proven] = (await qore.readContract({
        address: "0x0000000000000000000000000000000000000a02",
        abi: [{ type: "function", name: "pqcKeyStatus", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }, { type: "uint8" }, { type: "bytes" }, { type: "bool" }] }],
        functionName: "pqcKeyStatus", args: [owner],
      })) as readonly [boolean, number, Hex, boolean];
      return { tx: hit.transactionHash!, signer: bech32Of(owner), classical: executed, postQuantum: executed && registered && proven, lane: "pq-account" };
    }
  }
  const [registered, , , proven] = (await qore.readContract({
    address: "0x0000000000000000000000000000000000000a02",
    abi: [{ type: "function", name: "pqcKeyStatus", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }, { type: "uint8" }, { type: "bytes" }, { type: "bool" }] }],
    functionName: "pqcKeyStatus", args: [account],
  })) as readonly [boolean, number, Hex, boolean];
  return { tx: hit.transactionHash!, signer: bech32Of(account), classical: true, postQuantum: registered && proven, lane: "evm" };
}

/** Both signatures of a single-signer native transaction, verified with QoreSign against the chain's keys. */
async function verifyTx(hash: string, info: { "@type": string; key: string }, signer: string) {
  const raw = (await (await fetch(`${RPC}/tx?hash=0x${hash}`, { headers: { "user-agent": "curl/8.7.1" } })).json()) as any;
  const acc = await rest<any>(`/cosmos/auth/v1beta1/accounts/${signer}`);
  const base = acc.account?.base_account ?? acc.account;
  const pq = await rest<any>(`/qorechain/pqc/v1/account/${signer}`);
  const res = verifyHybridTx({
    txBytes: b64(raw.result.tx),
    chainId: CHAIN_ID,
    accountNumber: BigInt(base.account_number),
    classicalPublicKey: b64(info.key),
    classicalKeyType: String(info["@type"]).includes("ethsecp256k1") ? "eth_secp256k1" : "secp256k1",
    pqPublicKey: b64(pq.account.public_key),
    signBytesVersion: "either",
  });
  return { classical: res.classical, postQuantum: !!res.pq?.valid };
}

/** Any transaction by hash: its signer and whether both its signatures verify. */
export async function verifyTxByHash(hash: string): Promise<Provenance> {
  const t = (await rest<any>(`/cosmos/tx/v1beta1/txs/${hash}`)).tx_response;
  const info = t.tx.auth_info.signer_infos[0].public_key;
  const signer = t.tx.body.messages[0].sender ?? t.tx.body.messages[0].from_address;
  return { tx: hash, signer, ...(await verifyTx(hash, info, signer)) };
}
