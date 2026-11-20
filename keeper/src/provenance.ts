/**
 * Where a dossier came from, checked the way a custodian checks a deposit: the compliance officer finds the native
 * transaction that filed it and verifies both of its signatures with QoreSign, the secp256k1 one against the key in
 * the transaction and the ML-DSA-87 one against the key the account registered on chain. Only then does it read
 * the dossier. A dossier the chain accepted always passes (the chain runs the same check); doing it again here
 * means the officer's decision does not rest on trusting the node it reads from.
 */
import { fromBech32, toBech32 } from "@cosmjs/encoding";
import { decodeFunctionData, hexToBytes, keccak256, parseAbiItem, toHex, type Address, type Hex } from "viem";
import { qore } from "./net.js";
import { verifyHybridTx } from "@qorechain/qoresign";
import { artifact } from "./evm.js";
import { CHAIN_ID, RPC, rest } from "./net.js";

export type Provenance = { tx: string; signer: string; classical: boolean; postQuantum: boolean; lane?: "native" | "evm" };

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
    const hit = (t.tx.body.messages as any[]).some((m) => {
      if (m["@type"] !== "/qorechain.crossvm.v1.MsgCrossVMCall" || m.sender !== signer) return false;
      try {
        const call = decodeFunctionData({ abi, data: toHex(b64(m.payload)) });
        return call.functionName === "fileDossier" && keccak256(call.args![0] as Hex) === dossierHash;
      } catch {
        return false;
      }
    });
    if (!hit) continue;

    const res = await verifyTx(t.txhash, t.tx.auth_info.signer_infos[0].public_key, signer);
    return { tx: t.txhash, signer, ...res, lane: "native" };
  }
  return evmProvenance(access, account, dossierHash);
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
