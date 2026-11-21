import { NextResponse, type NextRequest } from 'next/server';
import { QORECHAIN } from '@/lib/deployments';

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

/**
 * Two transaction searches, for readers of native-lane calls (lib/native.ts), which leave no EVM log: the
 * transactions of one block, and the calls to one of Agama's contracts. Both are the same for every visitor, so the
 * CDN answers them: a block never changes, a contract's calls are at most 30 s stale.
 */
const CONTRACTS = new Set(
  [QORECHAIN.usdc, QORECHAIN.access, QORECHAIN.vault, QORECHAIN.dataRoom, QORECHAIN.allocator, QORECHAIN.pqAccountFactory].map((a) => a.toLowerCase()),
);
function search(req: NextRequest): { qs: string; cache: string } | null {
  const q = req.nextUrl.searchParams.get('query') ?? '';
  const page = req.nextUrl.searchParams.get('page') ?? '1';
  if (!/^\d{1,3}$/.test(page)) return null;
  const height = /^tx\.height=(\d{1,12})$/.exec(q);
  if (height) return { qs: new URLSearchParams({ query: q }).toString(), cache: 'public, s-maxage=86400, max-age=86400' };
  const target = /^crossvm_request\.target_contract='(0x[0-9a-f]{40})'$/.exec(q);
  if (target && CONTRACTS.has(target[1]))
    return {
      qs: new URLSearchParams({ query: q, order_by: 'ORDER_BY_DESC', 'pagination.limit': '100', page }).toString(),
      cache: 'public, s-maxage=30, stale-while-revalidate=60',
    };
  return null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const path = (await params).path.join('/');
  if (path === 'cosmos/tx/v1beta1/txs') {
    const s = search(req);
    if (!s) return NextResponse.json({ error: 'not allowed' }, { status: 404 });
    const res = await fetch(`${UPSTREAM}/${path}?${s.qs}`, { headers: { accept: 'application/json', 'user-agent': 'agama-qorechain/1.0' }, cache: 'no-store' });
    return new NextResponse(await res.text(), { status: res.status, headers: { 'content-type': 'application/json', 'cache-control': res.ok ? s.cache : 'no-store' } });
  }
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
