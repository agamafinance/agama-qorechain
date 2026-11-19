import { NextResponse, type NextRequest } from 'next/server';

/**
 * Read-only proxy to QoreChain's REST API, whose public endpoint sends no CORS headers. Only the few GET routes the
 * app reads are forwarded.
 */
const UPSTREAM = process.env.QORE_REST_UPSTREAM ?? 'https://api-testnet.qore.host';
const QOR = 'qor1[02-9ac-hj-np-z]{38}';
const ALLOWED = [
  new RegExp(`^cosmos/bank/v1beta1/balances/${QOR}$`),
  new RegExp(`^cosmos/auth/v1beta1/accounts/${QOR}$`),
  new RegExp(`^cosmos/auth/v1beta1/account_info/${QOR}$`),
  /^cosmos\/base\/tendermint\/v1beta1\/(node_info|blocks\/latest)$/,
  /^cosmos\/upgrade\/v1beta1\/applied_plan\/[a-z0-9.-]{1,40}$/,
  /^qorechain\/[a-z]+\/v1\/(params|protocol_features|evm_limits)$/,
  /^cosmos\/tx\/v1beta1\/txs\/[0-9A-Fa-f]{64}$/,
  new RegExp(`^qorechain/pqc/v1/account/${QOR}$`),
  new RegExp(`^qorechain/pqc/v1/kem/(${QOR}|0x[0-9a-fA-F]{40})$`),
  new RegExp(`^qorechain/pqc/v1/evm_window/${QOR}$`),
];

export async function GET(_req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const path = (await params).path.join('/');
  if (!ALLOWED.some((re) => re.test(path))) {
    console.warn('rest proxy refused GET', path);
    return NextResponse.json({ error: 'not allowed' }, { status: 404 });
  }
  const res = await fetch(`${UPSTREAM}/${path}`, {
    headers: { accept: 'application/json', 'user-agent': 'agama-qorechain/1.0' },
    cache: 'no-store',
  });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** Broadcast and simulate, for in-page signers (the QoreX test double in e2e/). The real QoreX broadcasts itself. */
const POST_ALLOWED = [/^cosmos\/tx\/v1beta1\/txs$/, /^cosmos\/tx\/v1beta1\/simulate$/];

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const path = (await params).path.join('/');
  if (!POST_ALLOWED.some((re) => re.test(path))) return NextResponse.json({ error: 'not allowed' }, { status: 404 });
  const body = await req.text();
  if (body.length > 200_000) return NextResponse.json({ error: 'too large' }, { status: 413 });
  const res = await fetch(`${UPSTREAM}/${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
  return new NextResponse(await res.text(), { status: res.status, headers: { 'content-type': 'application/json' } });
}
