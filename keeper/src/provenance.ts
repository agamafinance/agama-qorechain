/**
 * Where a dossier came from, checked the way a custodian checks a deposit: the compliance officer finds the native
 * transaction that filed it and verifies both of its signatures with QoreSign, the secp256k1 one against the key in
 * the transaction and the ML-DSA-87 one against the key the account registered on chain. Only then does it read
 * the dossier. A dossier the chain accepted always passes (the chain runs the same check); doing it again here
 * means the officer's decision does not rest on trusting the node it reads from.
 */
import { fromBech32, toBech32 } from "@cosmjs/encoding";
import { decodeFunctionData, hexToBytes, keccak256, toHex, type Address, type Hex } from "viem";
import { verifyHybridTx } from "@qorechain/qoresign";
import { artifact } from "./evm.js";
import { CHAIN_ID, RPC, rest } from "./net.js";

export type Provenance = { tx: string; signer: string; classical: boolean; postQuantum: boolean };

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

    const raw = (await (await fetch(`${RPC}/tx?hash=0x${t.txhash}`, { headers: { "user-agent": "curl/8.7.1" } })).json()) as any;
    const acc = await rest<any>(`/cosmos/auth/v1beta1/accounts/${signer}`);
    const base = acc.account?.base_account ?? acc.account;
    const pq = await rest<any>(`/qorechain/pqc/v1/account/${signer}`);
    const info = t.tx.auth_info.signer_infos[0].public_key;
    const res = verifyHybridTx({
      txBytes: b64(raw.result.tx),
      chainId: CHAIN_ID,
      accountNumber: BigInt(base.account_number),
      classicalPublicKey: b64(info.key),
      classicalKeyType: String(info["@type"]).includes("ethsecp256k1") ? "eth_secp256k1" : "secp256k1",
      pqPublicKey: b64(pq.account.public_key),
      signBytesVersion: "either",
    });
    return { tx: t.txhash, signer, classical: res.classical, postQuantum: !!res.pq?.valid };
  }
  return null;
}
