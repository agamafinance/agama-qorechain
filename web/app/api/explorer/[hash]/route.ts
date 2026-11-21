import { NextResponse, type NextRequest } from 'next/server';
import { nativeHash } from '@/lib/server/explorer';

/**
 * Opens a transaction on the QoreChain explorer. The explorer knows transactions by their native QoreChain hash; an
 * EVM transaction (the relayer's, the keeper's) is a MsgEthereumTx inside one, found by its
 * `ethereum_tx.ethereumTxHash` event. Runs only when someone clicks a link.
 */
const EXPLORER = 'https://explore.qore.network';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ hash: string }> }) {
  const hash = (await params).hash;
  if (/^[0-9A-Fa-f]{64}$/.test(hash)) return NextResponse.redirect(`${EXPLORER}/tx/${hash.toUpperCase()}`, 302);
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return NextResponse.json({ error: 'bad hash' }, { status: 400 });
  const native = await nativeHash(hash);
  if (!native) return NextResponse.redirect(EXPLORER, 302);
  return NextResponse.redirect(`${EXPLORER}/tx/${native}`, { status: 302, headers: { 'cache-control': 'public, max-age=86400' } });
}
