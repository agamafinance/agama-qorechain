import { NextResponse, type NextRequest } from 'next/server';

/**
 * The native QoreChain hash of an EVM transaction (the relayer's, the keeper's): the chain records each one as a
 * MsgEthereumTx inside a native transaction, found by its `ethereum_tx.ethereumTxHash` event. Used by the
 * transaction page (app/tx), only when someone opens one.
 */
const UPSTREAM = process.env.QORE_REST_UPSTREAM ?? 'https://api-testnet.qore.host';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ hash: string }> }) {
  const hash = (await params).hash.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) return NextResponse.json({ error: 'bad hash' }, { status: 400 });
  const q = encodeURIComponent(`ethereum_tx.ethereumTxHash='${hash}'`);
  // A transaction that just landed can take a few seconds to be indexed.
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${UPSTREAM}/cosmos/tx/v1beta1/txs?query=${q}`, { headers: { accept: 'application/json', 'user-agent': 'agama-qorechain/1.0' }, cache: 'no-store' }).catch(() => null);
    const native = r?.ok ? ((await r.json()) as { tx_responses?: { txhash: string }[] }).tx_responses?.[0]?.txhash : undefined;
    if (native) return NextResponse.json({ cosmosHash: native }, { headers: { 'cache-control': 'public, max-age=86400, immutable' } });
    await new Promise((res) => setTimeout(res, 1_500));
  }
  return NextResponse.json({ error: 'Transaction not found on qorechain-diana (yet)' }, { status: 404 });
}
