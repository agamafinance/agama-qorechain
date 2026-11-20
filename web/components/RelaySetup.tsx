'use client';

// The one-time setup for a lender on its usual QoreX account. QoreX has no screen for MsgCrossVMCall, so the lender
// signs each action as a message and Agama's relayer executes it as the lender. Before that: an EVM access window
// (opened in QoreX; the chain refuses EVM calls for an account without one) and a grant to the relayer (signed here).
// Renders nothing once both are in place.
import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { reason, useRelayStatus } from '@/lib/protocol';
import { authorizeRelayer } from '@/lib/qorex';
import { useWallet } from '@/lib/wallet';

export function useRelayReady() {
  const relay = useRelayStatus();
  return relay.data ? relay.data.window.live && !!relay.data.grant : false;
}

export function RelaySetup({ className = '' }: { className?: string }) {
  const { account } = useWallet();
  const relay = useRelayStatus();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  if (!account) return null;
  if (relay.error) {
    return <div className={`rounded-xl bg-[#b4571f]/10 px-4 py-3 text-[13px] text-fg ${className}`}>Agama&apos;s relayer is not reachable right now.</div>;
  }
  const s = relay.data;
  if (!s || (s.window.live && s.grant)) return null;

  const authorize = async () => {
    setErr(undefined);
    setBusy(true);
    try {
      await authorizeRelayer(account.address, s.relayer);
      await new Promise((r) => setTimeout(r, 3_000));
      await qc.invalidateQueries({ queryKey: ['relay'] });
    } catch (e) {
      setErr(reason(e));
    } finally {
      setBusy(false);
    }
  };

  const step = (done: boolean, n: number, title: string, body: React.ReactNode) => (
    <li className="flex gap-3">
      <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${done ? 'bg-[#2f7d5b] text-white' : 'bg-[#254839] text-[#fdf8ed]'}`}>
        {done ? <Check className="h-3 w-3" /> : n}
      </span>
      <div className="min-w-0">
        <div className={`text-[13px] font-medium ${done ? 'text-fg-muted line-through' : 'text-fg'}`}>{title}</div>
        {!done && <div className="mt-0.5 text-[12px] text-fg-muted">{body}</div>}
      </div>
    </li>
  );

  return (
    <div className={`rounded-xl border border-[#254839]/15 bg-white/70 px-4 py-4 ${className}`}>
      <div className="text-[14px] font-medium text-fg">One-time setup, two approvals in QoreX</div>
      <p className="mt-1 text-[12px] text-fg-muted">
        Then every action is a single signature, and Agama pays the gas. Needs a little QOR on your account.
      </p>
      <ol className="mt-3 space-y-3">
        {step(
          s.window.live,
          1,
          'Open an EVM access window in QoreX',
          <>
            In QoreX: <b>EVM access window</b> → how long <b>17280</b>, transactions <b>200</b>, spending cap <b>50</b> QOR →{' '}
            <b>Open the window</b>. QoreChain admits contract calls for your account only while it is open. This page
            notices by itself.
          </>,
        )}
        {step(
          !!s.grant,
          2,
          'Authorize Agama for 7 days',
          <>
            Lets Agama&apos;s relayer execute only the actions you sign, as you, on Agama&apos;s contracts.
            <button
              type="button"
              disabled={busy || !s.window.live}
              onClick={authorize}
              className="mt-2 flex items-center gap-2 rounded-full bg-[#254839] px-4 py-2 text-[13px] text-[#fdf8ed] disabled:opacity-40"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Authorize in QoreX
            </button>
          </>,
        )}
      </ol>
      {err && <p className="mt-2 text-[12px] text-[#9b2c2c]">{err}</p>}
    </div>
  );
}
