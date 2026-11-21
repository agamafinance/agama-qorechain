import { NextResponse, type NextRequest } from 'next/server';

/**
 * The explorer knows transactions by their QoreChain hash; an EVM transaction (the relayer's, the keeper's) is a
 * MsgEthereumTx inside one. This finds that hash from the EVM one and sends the visitor there. Only runs on a click.
 */
const UPSTREAM = process.env.QORE_REST_UPSTREAM ?? 'https://api-testnet.qore.host';
const EXPLORER = 'https://explore.qore.network';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ hash: string }> }) {
  const hash = (await params).hash.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) return NextResponse.json({ error: 'bad hash' }, { status: 400 });
  const q = encodeURIComponent(`ethereum_tx.ethereumTxHash='${hash}'`);
  // A transaction that just landed can take a few seconds to be indexed.
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${UPSTREAM}/cosmos/tx/v1beta1/txs?query=${q}`, { headers: { accept: 'application/json', 'user-agent': 'agama-qorechain/1.0' }, cache: 'no-store' }).catch(() => null);
    const native = r?.ok ? ((await r.json()) as { tx_responses?: { txhash: string }[] }).tx_responses?.[0]?.txhash : undefined;
    if (native) return NextResponse.redirect(`${EXPLORER}/tx/${native}`, { status: 302, headers: { 'cache-control': 'public, max-age=86400, immutable' } });
    await new Promise((res) => setTimeout(res, 1_500));
  }
  return NextResponse.redirect(EXPLORER, 302);
}
