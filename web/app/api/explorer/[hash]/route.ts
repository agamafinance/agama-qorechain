import { NextResponse, type NextRequest } from 'next/server';

/**
 * Opens a transaction on the QoreChain explorer. The explorer knows transactions by their native QoreChain hash; an
 * EVM transaction (the relayer's, the keeper's) is a MsgEthereumTx inside one, found by its
 * `ethereum_tx.ethereumTxHash` event. Runs only when someone clicks a link.
 */
const EXPLORER = 'https://explore.qore.network';
const UPSTREAM = process.env.QORE_REST_UPSTREAM ?? 'https://api-testnet.qore.host';

/** The native QoreChain hash of an EVM transaction: the chain records each one as a MsgEthereumTx inside one. */
async function nativeHash(evmHash: string): Promise<string | undefined> {
  const q = encodeURIComponent(`ethereum_tx.ethereumTxHash='${evmHash.toLowerCase()}'`);
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${UPSTREAM}/cosmos/tx/v1beta1/txs?query=${q}`, { headers: { accept: 'application/json', 'user-agent': 'agama-qorechain/1.0' }, cache: 'no-store' }).catch(() => null);
    const native = r?.ok ? ((await r.json()) as { tx_responses?: { txhash: string }[] }).tx_responses?.[0]?.txhash : undefined;
    if (native) return native;
    await new Promise((res) => setTimeout(res, 1_500));
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ hash: string }> }) {
  const hash = (await params).hash;
  if (/^[0-9A-Fa-f]{64}$/.test(hash)) return NextResponse.redirect(`${EXPLORER}/tx/${hash.toUpperCase()}`, 302);
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return NextResponse.json({ error: 'bad hash' }, { status: 400 });
  const native = await nativeHash(hash);
  if (!native) return NextResponse.redirect(EXPLORER, 302);
  return NextResponse.redirect(`${EXPLORER}/tx/${native}`, { status: 302, headers: { 'cache-control': 'public, max-age=86400' } });
}
