'use client';

// Getting verified, in the deposit card itself. One short form and one button: behind it the browser makes the
// lender's ML-KEM-1024 key, publishes it, seals the answers to the compliance officer and the auditor and files them
// on chain (two QoreX signatures), then waits for the officer's ML-DSA-87 decision and opens the sealed letter by
// itself. None of that is the lender's job to understand; the "How your data is protected" fold explains it to
// whoever wants to know.
import { useEffect, useState } from 'react';
import { Check, ChevronDown, Loader2, Lock } from 'lucide-react';
import { toHex, type Hex } from 'viem';
import type { SealKeyPair } from '@qorechain/qoreseal';
import { primaryBtn, Status } from './ui';
import { useActions, useDecision, useOfficerKeys, useUser } from '@/lib/protocol';
import { importSeed, loadKeys, openLetter, sealDossier, unlockKeys } from '@/lib/sealing';
import { keySignature } from '@/lib/qorex';
import { useWallet } from '@/lib/wallet';
import { useKeyReady } from './KeyNotice';
import { reason } from '@/lib/protocol';

const COUNTRIES: [string, string][] = [
  ['FR', 'France'], ['DE', 'Germany'], ['GB', 'United Kingdom'], ['CH', 'Switzerland'], ['NL', 'Netherlands'],
  ['BE', 'Belgium'], ['ES', 'Spain'], ['IT', 'Italy'], ['LU', 'Luxembourg'], ['IE', 'Ireland'], ['PT', 'Portugal'],
  ['AE', 'United Arab Emirates'], ['SG', 'Singapore'], ['HK', 'Hong Kong'], ['JP', 'Japan'], ['TR', 'Türkiye'],
  ['CA', 'Canada'], ['BR', 'Brazil'], ['US', 'United States'],
];

type Letter = { decision: 'approved' | 'rejected'; tierName?: string; reasons: string[] };

export function Onboarding() {
  // Without the ML-DSA-87 key on chain, the lender's Agama account cannot exist: the notice above says what to do.
  const keyReady = useKeyReady();
  const { account } = useWallet();
  const user = useUser();
  const act = useActions();
  const officers = useOfficerKeys();
  const decision = useDecision(user.member);
  const status = user.member?.status ?? 'None';

  const [keys, setKeys] = useState<SealKeyPair | null>(null);
  useEffect(() => setKeys(account ? loadKeys(account.evm) : null), [account]);

  const [f, setF] = useState({ name: '', country: 'FR', investorType: 'professional', confirm: false });
  const [step, setStep] = useState<string>();
  const [err, setErr] = useState<string>();
  const [restoring, setRestoring] = useState(false);
  const [seed, setSeed] = useState('');
  const [letter, setLetter] = useState<Letter>();

  // The decision letter opens by itself once it is on chain.
  useEffect(() => {
    if (!account || !keys || !decision.data?.letter) return;
    try {
      setLetter(openLetter<Letter>(account.evm, keys, decision.data.letter));
    } catch {
      setLetter(undefined);
    }
  }, [account, keys, decision.data?.letter]);

  if (!account) return null;

  const onChainKey = user.encryptionKey && user.encryptionKey !== '0x' ? user.encryptionKey : undefined;
  // A key is already on chain for this account but this browser does not hold it: the one case that needs the lender.
  const needsRestore = !!onChainKey && (!keys || toHex(keys.mlkemPublicKey) !== onChainKey) && status !== 'None';

  const verify = async () => {
    setErr(undefined);
    try {
      let k = keys;
      if (!k || (onChainKey && toHex(k.mlkemPublicKey) !== onChainKey)) {
        setStep('Unlocking your encryption key in QoreX');
        k = await unlockKeys(account.evm, keySignature);
        setKeys(k);
      }
      if (!onChainKey || onChainKey !== toHex(k.mlkemPublicKey)) {
        setStep('1 of 2 · Securing your encryption key');
        await act.publishKey(k.mlkemPublicKey);
      }
      setStep('2 of 2 · Sending your encrypted application');
      const envelope = sealDossier(
        account.evm,
        [officers.data!.compliance.recipient, officers.data!.auditor.recipient],
        {
          v: 1,
          name: f.name.trim(),
          country: f.country,
          investorType: f.investorType,
          attestations: { notUsPerson: f.confirm, notSanctioned: f.confirm, understandsRisk: f.confirm },
          declaredAt: new Date().toISOString(),
        },
        officers.data!.hybrid,
      ) as Hex;
      await act.fileDossier(envelope);
      setStep(undefined);
    } catch (e) {
      setStep(undefined);
      setErr(reason(e));
    }
  };

  const input = 'w-full rounded-xl border border-[#254839]/15 bg-white px-3 py-2.5 text-[14px] outline-none focus:border-[#254839]/40';

  return (
    <div className="mt-2 flex flex-1 flex-col">
      <Steps current={status === 'Pending' ? 1 : status === 'Approved' ? 2 : 0} />

      {status === 'Pending' && (
        <div className="mt-5 flex items-start gap-3 rounded-xl bg-[#254839]/[0.05] px-4 py-4 text-[14px]">
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-fg-muted" aria-hidden />
          <div>
            <div className="font-medium text-fg">Checking your application</div>
            <div className="text-fg-muted">Usually under a minute. You can leave this page; it updates by itself.</div>
          </div>
        </div>
      )}

      {needsRestore && status !== 'Pending' && (
        <div className="mt-5 rounded-xl bg-[#b4571f]/10 px-4 py-3 text-[13px] text-fg">
          This browser does not hold your encryption key yet.{' '}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={async () => {
              try {
                setKeys(await unlockKeys(account.evm, keySignature));
              } catch (e) {
                setErr(reason(e));
              }
            }}
          >
            Unlock it with QoreX
          </button>{' '}
          (one signature, no transaction), or
          {restoring ? (
            <div className="mt-2 flex gap-2">
              <input className={input} placeholder="0x…" value={seed} onChange={(e) => setSeed(e.target.value)} />
              <button
                type="button"
                className="rounded-full bg-[#254839] px-4 text-[13px] text-[#fdf8ed]"
                onClick={() => {
                  try {
                    setKeys(importSeed(account.evm, seed));
                    setRestoring(false);
                  } catch {
                    setErr('That is not a valid key backup.');
                  }
                }}
              >
                Restore
              </button>
            </div>
          ) : (
            <button type="button" className="mt-1 underline underline-offset-2" onClick={() => setRestoring(true)}>
              Restore from backup
            </button>
          )}
        </div>
      )}

      {status === 'Rejected' && letter && (
        <div className="mt-5 rounded-xl bg-[#b4571f]/10 px-4 py-3 text-[13px] text-fg">
          <div className="font-medium">Not approved</div>
          {letter.reasons.map((r) => (
            <div key={r}>{r}</div>
          ))}
        </div>
      )}

      {(status === 'None' || status === 'Rejected' || status === 'Revoked') && (
        <>
          <p className="mt-5 text-[13px] text-fg-muted">
            agUSD is for verified investors. Your answers are encrypted on your device; only compliance and the
            auditor can read them.
          </p>
          <div className="mt-3 space-y-2.5">
            <input className={input} placeholder="Full legal name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <div className="grid grid-cols-2 gap-2.5">
              <select className={input} value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })}>
                {COUNTRIES.map(([c, n]) => (
                  <option key={c} value={c}>
                    {n}
                  </option>
                ))}
              </select>
              <select className={input} value={f.investorType} onChange={(e) => setF({ ...f, investorType: e.target.value })}>
                <option value="professional">Professional investor</option>
                <option value="institutional">Institution</option>
                <option value="accredited-individual">Accredited individual</option>
                <option value="retail">Retail investor</option>
              </select>
            </div>
            <label className="flex items-start gap-2 text-[13px] text-fg">
              <input type="checkbox" className="mt-0.5" checked={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.checked })} />
              I am not a US person, not subject to sanctions, and I understand private credit can lose value and exits
              can queue.
            </label>
          </div>
          <button
            type="button"
            className={`mt-4 ${primaryBtn}`}
            disabled={!!step || !keyReady || f.name.trim().length < 2 || !f.confirm || !officers.data}
            onClick={verify}
          >
            {step ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {step}
              </span>
            ) : (
              'Get verified'
            )}
          </button>
          <p className="mt-2 text-center text-[12px] text-fg-muted">A few signatures in QoreX. No gas, nothing to set up.</p>
          <Status error={err} />
        </>
      )}

      <HowProtected />
    </div>
  );
}

function Steps({ current }: { current: number }) {
  const steps = ['Verify', 'Review', 'Deposit'];
  return (
    <ol className="flex items-center gap-2 text-[12px]">
      {steps.map((s, i) => (
        <li key={s} className="flex items-center gap-2">
          <span
            className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${
              i < current ? 'bg-[#2f7d5b] text-white' : i === current ? 'bg-[#254839] text-[#fdf8ed]' : 'bg-[#254839]/[0.08] text-fg-muted'
            }`}
          >
            {i < current ? <Check className="h-3.5 w-3.5" /> : i + 1}
          </span>
          <span className={i === current ? 'font-medium text-fg' : 'text-fg-muted'}>{s}</span>
          {i < steps.length - 1 && <span className="mx-1 h-px w-6 bg-[#254839]/20" />}
        </li>
      ))}
    </ol>
  );
}

function HowProtected() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-auto pt-4">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-[12px] text-fg-muted hover:text-fg">
        <Lock className="h-3.5 w-3.5" aria-hidden /> How your data is protected
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open && (
        <ul className="mt-2 space-y-1 text-[12px] text-fg-muted">
          <li>Your answers are encrypted in this browser with ML-KEM-1024 (QoreSeal); the chain only stores ciphertext.</li>
          <li>Your key is made here, never leaves the device, and is published from your Agama account.</li>
          <li>Your Agama account is a contract only your ML-DSA-87 key controls: every signature is checked on chain by pqcVerify.</li>
          <li>The decision is signed with ML-DSA-87 and checked on chain by QoreChain&apos;s pqcVerify.</li>
          <li>Back up your key from Portfolio to read your letter and the data room on another device.</li>
        </ul>
      )}
    </div>
  );
}
