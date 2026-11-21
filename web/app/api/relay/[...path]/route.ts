import { NextResponse, type NextRequest } from 'next/server';
import { refusal, relayerConfigured, submit } from '@/lib/server/relay';

/**
 * Agama's relayer. Deployed, it runs here (lib/server/relay.ts, with RELAYER_PRIVATE_KEY); locally without that key,
 * requests go to the keeper's relayer (keeper/src/relayer.ts on RELAYER_URL). One route: a message signed for a
 * PqAccount (pq). The earlier authz path (status, act) only exists on the keeper's relayer.
 */
const UPSTREAM = process.env.RELAYER_URL ?? 'http://localhost:3047';
export const maxDuration = 60;

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  if ((await params).path.join('/') !== 'status' || relayerConfigured()) return NextResponse.json({ error: 'not found' }, { status: 404 });
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
  if (path !== 'pq' && (path !== 'act' || relayerConfigured())) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const body = await req.text();
  if (body.length > 200_000) return NextResponse.json({ error: 'too large' }, { status: 413 });
  if (relayerConfigured()) {
    try {
      return NextResponse.json(await submit(JSON.parse(body)));
    } catch (e) {
      console.log('refused:', String((e as Error)?.message ?? e).split('\n')[0].slice(0, 300));
      return NextResponse.json({ error: refusal(e) }, { status: 400 });
    }
  }
  try {
    const r = await fetch(`${UPSTREAM}/relay/${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    return new NextResponse(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } });
  } catch {
    return NextResponse.json({ error: "Agama's relayer is not reachable" }, { status: 503 });
  }
}
