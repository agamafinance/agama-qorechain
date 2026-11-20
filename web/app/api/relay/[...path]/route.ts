import { NextResponse, type NextRequest } from 'next/server';

/**
 * Proxy to Agama's relayer (keeper/src/relayer.ts), which holds its own key server-side. Only two routes are
 * forwarded: a message signed for a PqAccount (pq), and the earlier authz path (status, act).
 */
const UPSTREAM = process.env.RELAYER_URL ?? 'http://localhost:3047';

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  if ((await params).path.join('/') !== 'status') return NextResponse.json({ error: 'not found' }, { status: 404 });
  const account = req.nextUrl.searchParams.get('account') ?? '';
  try {
    const r = await fetch(`${UPSTREAM}/relay/status?account=${encodeURIComponent(account)}`, { cache: 'no-store' });
    return new NextResponse(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } });
  } catch {
    return NextResponse.json({ error: "Agama's relayer is not reachable" }, { status: 503 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const path = (await params).path.join('/');
  if (path !== 'pq' && path !== 'act') return NextResponse.json({ error: 'not found' }, { status: 404 });
  const body = await req.text();
  if (body.length > 200_000) return NextResponse.json({ error: 'too large' }, { status: 413 });
  try {
    const r = await fetch(`${UPSTREAM}/relay/${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    return new NextResponse(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } });
  } catch {
    return NextResponse.json({ error: "Agama's relayer is not reachable" }, { status: 503 });
  }
}
