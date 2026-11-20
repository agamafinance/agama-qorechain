'use client';

import { useState } from 'react';
import Link from 'next/link';
import { card, primaryBtn } from '@/components/ui';
import { fmt, usd } from '@/lib/format';
import { qoreAddress } from '@/lib/chains';
import { useWallet } from '@/lib/wallet';
import { backupFile, importSeed, loadKeys, unlockKeys } from '@/lib/sealing';
import { keySignature } from '@/lib/qorex';
import { useActions, useRequests, useUser, useVault } from '@/lib/protocol';
import { asset } from '@/lib/asset';

export default function PortfolioPage() {
  const { connect } = useWallet();
  const user = useUser();
  const { vault } = useVault();
  const { data: requests } = useRequests();
  const act = useActions();
  const [busy, setBusy] = useState<string | null>(null);

  const price = vault?.sharePrice ?? 1_000_000n;
  const agValue = user.agusd !== undefined ? (user.agusd * price) / 1_000_000n : undefined;
  const open = (requests ?? []).filter((r) => !r.settled);
  // Everything the wallet owns, including what it owns while leaving. The agUSD is burned when an exit queues and
  // the claim on it lives in the vault, so counting only the balances made the money look like it had gone.
  const leaving = open.reduce((a, r) => a + r.assets, 0n);
  const loaded = user.usdc !== undefined && agValue !== undefined;
  const netWorth = loaded ? user.usdc! + agValue! + leaving : 0n;

  return (
    <section className="px-6 md:px-24 pt-10 md:pt-14 pb-24">
      <div className="max-w-[1400px] mx-auto">
        <h1 className="mt-2 text-[34px] text-fg font-semibold">Portfolio</h1>

        {!user.address ? (
          <div className={`mt-8 text-center ${card}`}>
            <p className="text-[15px] text-fg-muted">Connect your wallet to view your positions.</p>
            <div className="mx-auto mt-4 max-w-[260px]">
              <button type="button" onClick={connect} className={primaryBtn}>
                Connect QoreX
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className={`mt-6 ${card}`}>
              <div className="text-[12px] uppercase tracking-wider text-fg-muted">Net worth</div>
              <div className="text-[34px] text-fg font-semibold tabular-nums">
                {loaded ? usd(netWorth) : <span className="text-fg-muted/40">$0.00</span>}
              </div>
              {leaving > 0n && (
                <div className="text-[12px] text-fg-muted">Includes {usd(leaving)} on its way out.</div>
              )}
              <a
                href={qoreAddress(user.account?.address ?? user.address)}
                target="_blank"
                rel="noreferrer"
                className="mt-1 block text-[12px] text-fg-muted break-all underline-offset-2 hover:text-fg hover:underline"
              >
                {user.account?.address}
              </a>
              <div className="flex flex-wrap items-center gap-2">
                <AccessBadge status={user.member?.status} expiresAt={user.member?.expiresAt} />
                <KeyBackup evm={user.address} />
              </div>
            </div>

            <div className="mt-4 space-y-3">
              <Position logo="/logos/usdc.svg" symbol="USDC" name="Mock USDC" amount={loaded ? fmt(user.usdc) : '-'} href="/faucet" />
              <Position
                logo="/logos/agusd.svg"
                symbol="agUSD"
                name="Agama USD"
                amount={loaded ? fmt(user.agusd) : '-'}
                sub={agValue !== undefined ? `${fmt(agValue)} USDC at today's price` : undefined}
                href="/"
              />
              {user.usdc === 0n && user.agusd === 0n && open.length === 0 && (
                <p className="rounded-2xl bg-[#fdfaf1] px-5 py-4 text-[14px] text-fg-muted shadow-[0_1px_3px_rgba(20,50,35,0.06)]">
                  Nothing here yet. Get verified and deposit on{' '}
                  <Link href="/" className="underline underline-offset-2">Earn</Link>; the share price does the rest.
                </p>
              )}
            </div>

            {open.length > 0 && (
              <div className="mt-8">
                <h2 className="text-[15px] font-semibold">Withdrawal queue</h2>
                <p className="mt-1 text-[12.5px] leading-snug text-fg-muted">
                  Your agUSD is already burned for each of these, priced when you asked. The queue is paid strictly
                  in order as the book&apos;s collections come home from Ethereum. Nobody can jump it and nobody can
                  hold it up: anyone may push it along, and each claim pays its own owner.
                </p>
                <div className="mt-3 space-y-2">
                  {open.map((r) => (
                    <div
                      key={String(r.id)}
                      className="flex items-center justify-between rounded-xl border border-black/10 px-3.5 py-2.5"
                    >
                      <div>
                        <div className="text-[13.5px] font-medium">{usd(r.assets)} USDC</div>
                        <span className="text-[12px] text-fg-muted">
                          Claim #{String(r.id)} · queued {new Date(Number(r.requestedAt) * 1000).toLocaleString()} · waiting for collections
                        </span>
                      </div>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={async () => {
                          setBusy(String(r.id));
                          try {
                            await act.settle();
                          } catch {
                            // The toast carries the reason.
                          } finally {
                            setBusy(null);
                          }
                        }}
                        className="rounded-lg bg-[#254839] px-3 py-1.5 text-[12.5px] font-medium text-[#fdf8ed] disabled:opacity-50"
                      >
                        {busy === String(r.id) ? 'Submitting' : 'Push the queue'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/// The encryption key lives in this browser. Backing it up is the one thing the lender should do once; on another
/// browser, restoring it is what opens the letter and the data room again.
function KeyBackup({ evm }: { evm: `0x${string}` }) {
  const [keys, setKeys] = useState(() => (typeof window === 'undefined' ? null : loadKeys(evm)));
  const [restoring, setRestoring] = useState(false);
  const [seed, setSeed] = useState('');
  const [err, setErr] = useState<string>();
  if (!keys) {
    return restoring ? (
      <span className="mt-3 inline-flex items-center gap-2">
        <input
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          placeholder="Paste the seed (0x…) from your backup"
          className="w-[300px] rounded-full border border-[#254839]/20 bg-white px-3 py-1 text-[12px] outline-none"
        />
        <button
          type="button"
          className="rounded-full bg-[#254839] px-3 py-1 text-[12px] text-[#fdf8ed]"
          onClick={() => {
            try {
              setKeys(importSeed(evm, seed));
              setErr(undefined);
            } catch {
              setErr('Not a valid backup');
            }
          }}
        >
          Restore
        </button>
        {err && <span className="text-[12px] text-[#9b2c2c]">{err}</span>}
      </span>
    ) : (
      <span className="mt-3 inline-flex gap-2">
        <button
          type="button"
          onClick={async () => {
            try {
              setKeys(await unlockKeys(evm, keySignature));
            } catch {
              setErr('Signature declined');
            }
          }}
          className="rounded-full bg-[#254839]/[0.08] px-3 py-1 text-[12px] text-[#254839] hover:bg-[#254839]/[0.16]"
        >
          Unlock my encryption key with QoreX
        </button>
        <button type="button" onClick={() => setRestoring(true)} className="text-[12px] text-fg-muted underline underline-offset-2">
          or restore a backup
        </button>
        {err && <span className="text-[12px] text-[#9b2c2c]">{err}</span>}
      </span>
    );
  }
  const download = () => {
    const url = URL.createObjectURL(backupFile(evm, keys));
    const a = document.createElement('a');
    a.href = url;
    a.download = `agama-key-${evm.slice(2, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <button type="button" onClick={download} className="mt-3 rounded-full bg-[#254839]/[0.08] px-3 py-1 text-[12px] text-[#254839] hover:bg-[#254839]/[0.16]">
      Back up my encryption key
    </button>
  );
}

function AccessBadge({ status, expiresAt }: { status?: string; expiresAt?: bigint }) {
  if (!status) return null;
  const text =
    status === 'Approved'
      ? `Approved lender until ${new Date(Number(expiresAt ?? 0n) * 1000).toLocaleDateString()}`
      : status === 'Pending'
        ? 'Application in review'
        : status === 'None'
          ? 'Not verified yet: get verified on Earn'
          : `Access ${status.toLowerCase()}`;
  return (
    <Link
      href="/"
      className={`mt-3 inline-flex rounded-full px-3 py-1 text-[12px] ${status === 'Approved' ? 'bg-[#2f7d5b]/10 text-[#2f7d5b]' : 'bg-[#254839]/[0.08] text-[#254839]'}`}
    >
      {text}
    </Link>
  );
}

function Position({
  logo,
  symbol,
  name,
  amount,
  sub,
  href,
}: {
  logo: string;
  symbol: string;
  name: string;
  amount: string;
  sub?: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-4 rounded-2xl bg-[#fdfaf1] px-5 py-4 shadow-[0_1px_3px_rgba(20,50,35,0.06)]"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={asset(logo)} alt="" width={36} height={36} className="h-9 w-9" />
      <div>
        <div className="text-[15px] text-fg font-medium">{symbol}</div>
        <div className="text-[13px] text-fg-muted">{name}</div>
      </div>
      <div className="ml-auto text-right">
        <div className="text-[16px] text-fg font-semibold tabular-nums">{amount}</div>
        {sub && <div className="text-[12px] text-fg-muted">{sub}</div>}
      </div>
    </Link>
  );
}
