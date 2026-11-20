'use client';

// The data room: the credit book's loan tape, on chain, encrypted to the vault's approved lenders and the auditor.
//
// Each membership epoch has a 32-byte group key, sealed with ML-KEM-1024 to every member's published key; each tape
// is a QoreSeal private batch under that key (AES-256-GCM, with SHA3-256 commitments). Both are signed by the
// manager with ML-DSA-87 and checked by pqcVerify. Decryption happens here, with the key this browser holds.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Lock, LockOpen, ShieldCheck } from 'lucide-react';
import { hexToBytes, toHex, type Hex } from 'viem';
import { openBatch, openEpochKey, type EpochKey } from '@qorechain/qoreseal';
import { card, Hero, Panel, primaryBtn, Stat } from '@/components/ui';
import { qoreTx } from '@/lib/chains';
import { usd } from '@/lib/format';
import { kb, useDataRoom, useUser, type RoomReport } from '@/lib/protocol';
import { loadKeys, SEAL, unlockKeys } from '@/lib/sealing';
import { keySignature } from '@/lib/qorex';
import { useWallet } from '@/lib/wallet';

type Loan = {
  id: string;
  borrower: string;
  country: string;
  sleeve: string;
  collateral: string;
  outstanding: string;
  rateBps: number;
  maturity: string;
  ltvBps: number;
  status: 'current' | 'watch' | '30dpd';
};
type Tape = {
  asOf: string;
  aprBps: number;
  book: string;
  sleeves: { name: string; outstanding: string; loans: number; weightedRateBps: number }[];
  loans: Loan[];
  concentration: { largestBorrowerBps: number; topFiveBps: number };
  delinquency: { watchBps: number; dpd30Bps: number };
};

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

export default function DataRoomPage() {
  const { account, connect } = useWallet();
  const user = useUser();
  const room = useDataRoom();
  const [epochKey, setEpochKey] = useState<EpochKey>();
  const [tape, setTape] = useState<{ t: Tape; report: RoomReport; verified: boolean }>();
  const [err, setErr] = useState<string>();

  useEffect(() => {
    setEpochKey(undefined);
    setTape(undefined);
    setErr(undefined);
  }, [account?.evm, room.data?.current?.epoch]);

  const current = room.data?.current;
  // Members do not click anything: the tape opens by itself when this browser holds their key.
  useEffect(() => {
    if (account && current?.isMember && current.distribution && !epochKey && !err && loadKeys(account.evm)) unlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.evm, current?.epoch, current?.distribution]);
  const latest = room.data?.reports.find((r) => current && r.epoch === current.epoch && r.blob);

  const unlock = async () => {
    setErr(undefined);
    try {
      // No key in this browser yet: one QoreX signature derives it (the same key on any device).
      const keys = loadKeys(account!.evm) ?? (await unlockKeys(account!.evm, keySignature));
      const ek = openEpochKey({ chainId: SEAL.chainId, purpose: SEAL.epoch, envelope: hexToBytes(current!.distribution!), keys });
      setEpochKey(ek);
      if (latest?.blob) {
        const b = openBatch({ blob: hexToBytes(latest.blob), keys: [ek] });
        const t = JSON.parse(new TextDecoder().decode(b.data)) as Tape;
        setTape({ t, report: latest, verified: toHex(b.ciphertextCommitment) === latest.ciphertextCommitment });
      }
    } catch (e) {
      setErr(e instanceof Error && /declined|rejected/i.test(e.message) ? 'You declined the signature in QoreX.' : 'Your key does not open this epoch: only approved lenders and the auditor are in it.');
    }
  };

  return (
    <>
      <Hero art="/logos/book.svg" title="The data room">
        <p className="mt-4 max-w-[680px] text-[15px] text-fg-muted">
          Every loan behind agUSD: who borrowed, against what, at what rate, and whether they pay. Only verified
          investors and the auditor can read it; it opens right here, on your device.
        </p>
        <div className="mt-7 flex flex-wrap gap-8">
          <Stat label="Epoch" value={current ? String(current.epoch) : '-'} sub="A new key at every membership change" />
          <Stat label="Readers" value={current ? `${current.members} + auditor` : '-'} sub={current ? `Key sealed in ${current.parts} parts of up to 8` : 'Approved lenders, sealed to'} />
          <Stat label="Sealed tapes" value={room.data ? String(room.data.reportCount) : '-'} sub="Signed with ML-DSA-87" />
        </div>
      </Hero>

      <Panel>
        <div className={card}>
          {!account ? (
            <div className="text-center">
              <p className="text-[15px] text-fg-muted">Connect QoreX to open the data room.</p>
              <div className="mx-auto mt-4 max-w-[260px]">
                <button type="button" onClick={connect} className={primaryBtn}>
                  Connect QoreX
                </button>
              </div>
            </div>
          ) : !current ? (
            <p className="text-[14px] text-fg-muted">No epoch yet: the room opens with its first approved lender.</p>
          ) : !current.isMember ? (
            <div className="flex flex-wrap items-center gap-4">
              <Lock className="h-6 w-6 text-fg-muted" aria-hidden />
              <p className="flex-1 text-[14px] text-fg-muted">
                {user.member?.status === 'Approved'
                  ? 'You are verified: the next key rotation, within minutes, includes you.'
                  : 'The loan tape is encrypted for verified investors only. Get verified on Earn to read it.'}
              </p>
              {user.member?.status !== 'Approved' && (
                <Link href="/" className="rounded-full bg-[#254839] px-5 py-2.5 text-[14px] text-[#fdf8ed]">
                  Get verified
                </Link>
              )}
            </div>
          ) : !current.distribution ? (
            <p className="text-[14px] text-fg-muted">You are a reader of epoch {String(current.epoch)}; its key is being posted, part by part.</p>
          ) : !epochKey ? (
            <div className="flex flex-wrap items-center gap-4">
              <ShieldCheck className="h-6 w-6 text-[#2f7d5b]" aria-hidden />
              <p className="flex-1 text-[14px] text-fg">
                You are a reader of epoch {String(current.epoch)}. Its key is sealed to yours in a {kb(current.distribution)} envelope, one of {current.parts}.
              </p>
              <button type="button" onClick={unlock} className="rounded-full bg-[#254839] px-5 py-2.5 text-[14px] text-[#fdf8ed]">
                <LockOpen className="mr-2 inline h-4 w-4" aria-hidden />
                {account && loadKeys(account.evm) ? 'Decrypt in this browser' : 'Unlock with QoreX'}
              </button>
            </div>
          ) : !tape ? (
            <p className="text-[14px] text-fg-muted">Epoch key opened. No tape published under it yet; the next arrives within the hour.</p>
          ) : (
            <TapeView tape={tape.t} report={tape.report} verified={tape.verified} />
          )}
          {err && <p className="mt-3 text-[13px] text-[#9b2c2c]">{err}</p>}
        </div>

        <div className={card}>
          <h2 className="text-[13px] uppercase tracking-wider text-fg-muted">On chain, as anyone sees it</h2>
          <div className="mt-3 divide-y divide-[#254839]/10 text-[13px]">
            {(room.data?.reports ?? []).map((r) => (
              <div key={String(r.index)} className="grid gap-1 py-2.5 md:grid-cols-[110px_90px_1fr_auto] md:items-center md:gap-4">
                <div className="font-medium text-fg">Tape #{String(r.index)}</div>
                <div className="text-fg-muted">epoch {String(r.epoch)}</div>
                <div className="truncate font-mono text-[11px] text-fg-muted" title={r.ciphertextCommitment}>
                  {r.size.toLocaleString()} bytes · commitment {r.ciphertextCommitment.slice(0, 18)}…
                </div>
                {r.tx ? (
                  <a href={qoreTx(r.tx)} target="_blank" rel="noreferrer" className="text-fg-muted underline-offset-2 hover:underline">
                    {new Date(Number(r.publishedAt) * 1000).toLocaleString()}
                  </a>
                ) : (
                  <span className="text-fg-muted">{new Date(Number(r.publishedAt) * 1000).toLocaleString()}</span>
                )}
              </div>
            ))}
            {room.data && room.data.reports.length === 0 && <div className="py-2.5 text-fg-muted">Nothing published yet.</div>}
          </div>
        </div>
      </Panel>
    </>
  );
}

function TapeView({ tape, report, verified }: { tape: Tape; report: RoomReport; verified: boolean }) {
  const book = BigInt(tape.book);
  const badge = (s: Loan['status']) =>
    s === 'current' ? 'bg-[#2f7d5b]/10 text-[#2f7d5b]' : s === 'watch' ? 'bg-[#b48a1f]/10 text-[#8a6a14]' : 'bg-[#b4571f]/10 text-[#b4571f]';
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[17px] font-semibold text-fg">Loan tape as of {tape.asOf}</h2>
        <span className="text-[12px] text-fg-muted">
          Tape #{String(report.index)}, decrypted here · {verified ? 'ciphertext matches its on-chain commitment' : 'commitment mismatch'}
        </span>
      </div>
      <div className="mt-4 flex flex-wrap gap-8">
        <Stat label="Book" value={usd(book, 0)} sub={`Target ${pct(tape.aprBps)}`} />
        <Stat label="Largest borrower" value={pct(tape.concentration.largestBorrowerBps)} sub={`Top five ${pct(tape.concentration.topFiveBps)}`} />
        <Stat label="Watch list" value={pct(tape.delinquency.watchBps)} sub="Of the book" />
        <Stat label="30+ days past due" value={pct(tape.delinquency.dpd30Bps)} sub="Of the book" />
      </div>
      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {tape.sleeves.map((s) => (
          <div key={s.name} className="rounded-xl bg-[#254839]/[0.05] px-4 py-3">
            <div className="text-[14px] font-medium text-fg">{s.name}</div>
            <div className="text-[13px] text-fg-muted">
              {usd(BigInt(s.outstanding), 0)} · {s.loans} facilities · {pct(s.weightedRateBps)}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[820px] text-left text-[13px]">
          <thead className="text-[11px] uppercase tracking-wider text-fg-muted">
            <tr>
              {['Facility', 'Borrower', 'Collateral', 'Outstanding', 'Rate', 'LTV', 'Maturity', 'Status'].map((h) => (
                <th key={h} className="py-2 pr-4 font-normal">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[#254839]/10">
            {tape.loans.map((l) => (
              <tr key={l.id}>
                <td className="py-2 pr-4 font-mono text-[12px]">{l.id}</td>
                <td className="py-2 pr-4 text-fg">
                  {l.borrower} <span className="text-fg-muted">· {l.country}</span>
                </td>
                <td className="py-2 pr-4 text-fg-muted">{l.collateral}</td>
                <td className="py-2 pr-4 tabular-nums">{usd(BigInt(l.outstanding), 0)}</td>
                <td className="py-2 pr-4 tabular-nums">{pct(l.rateBps)}</td>
                <td className="py-2 pr-4 tabular-nums">{pct(l.ltvBps)}</td>
                <td className="py-2 pr-4 tabular-nums">{l.maturity}</td>
                <td className="py-2 pr-4">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] ${badge(l.status)}`}>{l.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
