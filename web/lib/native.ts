// Reading Agama's native-lane calls in the browser. A MsgCrossVMCall executes the contract but leaves no EVM log the
// chain serves, so what used to come from events is read from the committed transaction (through this app's REST
// proxy, CDN-cached) and checked against contract state by the caller. The same reader as keeper/src/chain.ts.
import { decodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import { REST } from './chains';

export type NativeCall = { hash: string; height: bigint; time: number; memo: string; sender: string; data: Hex };

const b64ToHex = (s: string) => ('0x' + Array.from(atob(s), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')) as Hex;
type TxResponse = { txhash: string; height: string; timestamp: string; code: number; events?: { type: string; attributes: { key: string; value: string }[] }[]; tx?: { body?: { memo?: string; messages?: Record<string, string>[] } } };

function callsIn(t: TxResponse, target: Address): NativeCall[] {
  const executed = t.code === 0 && (t.events ?? []).some((e) => e.type === 'crossvm_response' && e.attributes.some((a) => a.key === 'status' && a.value === 'executed'));
  if (!executed) return [];
  return (t.tx?.body?.messages ?? [])
    .filter((m) => m['@type'] === '/qorechain.crossvm.v1.MsgCrossVMCall' && m.payload && String(m.target_contract).toLowerCase() === target.toLowerCase())
    .map((m) => ({ hash: t.txhash, height: BigInt(t.height), time: Date.parse(t.timestamp) / 1000, memo: t.tx?.body?.memo ?? '', sender: m.sender, data: b64ToHex(m.payload) }));
}

/** The executed native calls to `target` in block `height` (a block the contract's state points at). */
export async function callsAt(height: bigint, target: Address): Promise<NativeCall[]> {
  const r = await fetch(`${REST}/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(`tx.height=${height}`)}`).catch(() => null);
  if (!r?.ok) return [];
  return (((await r.json()) as { tx_responses?: TxResponse[] }).tx_responses ?? []).flatMap((t) => callsIn(t, target));
}

/** The latest executed native calls to `target` (up to `pages` hundred transactions), newest first. */
export async function recentCalls(target: Address, pages = 1): Promise<NativeCall[]> {
  const out: NativeCall[] = [];
  for (let page = 1; page <= pages; page++) {
    const q = encodeURIComponent(`crossvm_request.target_contract='${target.toLowerCase()}'`);
    const r = await fetch(`${REST}/cosmos/tx/v1beta1/txs?query=${q}&page=${page}`).catch(() => null);
    if (!r?.ok) break;
    const j = (await r.json()) as { tx_responses?: TxResponse[]; total?: string };
    out.push(...(j.tx_responses ?? []).flatMap((t) => callsIn(t, target)));
    if ((j.tx_responses ?? []).length < 100) break;
  }
  return out;
}

/** The arguments of a native call to `name`, or null when it is another function. */
export function decode<T = readonly unknown[]>(c: NativeCall, abi: Abi, name: string): T | null {
  try {
    const d = decodeFunctionData({ abi, data: c.data });
    return d.functionName === name ? (d.args as T) : null;
  } catch {
    return null;
  }
}
