'use client';

// Access: how a lender gets into a permissioned vault without putting its identity on a public chain.
//
//   1. a QoreSeal key pair is made in this browser; its ML-KEM-1024 public key is published on chain by a QoreX
//      transaction, hybrid-signed, so the encryption key is bound to the lender's ML-DSA-87 key
//   2. the KYC answers are sealed here, to the compliance officer and the auditor, with the keys they published in
//      QoreChain's KEM registry; the chain stores ciphertext and nothing else
//   3. the officer's decision is an ML-DSA-87 signature checked by pqcVerify, and its letter is sealed to the lender,
//      who opens it here, with the key that never left this browser
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Check, Download, KeyRound, Lock, ShieldCheck, Upload } from 'lucide-react';
import type { Hex } from 'viem';
import { toHex } from 'viem';
import type { SealKeyPair } from '@qorechain/qoreseal';
import { card, Hero, Panel, primaryBtn, secondaryBtn, Status } from '@/components/ui';
import { TxButton } from '@/components/TxButton';
import { qoreTx } from '@/lib/chains';
import { kb, useActions, useDecision, useOfficerKeys, useUser } from '@/lib/protocol';
import { backupFile, createKeys, importSeed, loadKeys, openLetter, sealDossier } from '@/lib/sealing';
import { useWallet } from '@/lib/wallet';

type Letter = {
  decision: 'approved' | 'rejected';
  tierName?: string;
  expiresAt?: number;
  reasons: string[];
  dossierHash: Hex;
  reviewedAt: string;
  reviewer: string;
};

const COUNTRIES: [string, string][] = [
  ['FR', 'France'], ['DE', 'Germany'], ['GB', 'United Kingdom'], ['CH', 'Switzerland'], ['NL', 'Netherlands'],
  ['BE', 'Belgium'], ['ES', 'Spain'], ['IT', 'Italy'], ['LU', 'Luxembourg'], ['IE', 'Ireland'], ['PT', 'Portugal'],
  ['AE', 'United Arab Emirates'], ['SG', 'Singapore'], ['HK', 'Hong Kong'], ['JP', 'Japan'], ['TR', 'Türkiye'],
  ['CA', 'Canada'], ['BR', 'Brazil'], ['US', 'United States'], ['RU', 'Russia'],
];

const fingerprint = (k?: Uint8Array) => (k ? toHex(k.slice(0, 6)).slice(2).match(/../g)!.join(':') : '');

export default function AccessPage() {
  const { account, connect } = useWallet();
  const user = useUser();
  const act = useActions();
  const officers = useOfficerKeys();
  const decision = useDecision(user.member);

  const [keys, setKeys] = useState<SealKeyPair | null>(null);
  useEffect(() => setKeys(account ? loadKeys(account.evm) : null), [account]);

  const published = !!keys && !!user.encryptionKey && user.encryptionKey === toHex(keys.mlkemPublicKey);
  const status = user.member?.status ?? 'None';

  return (
    <>
      <Hero
        art="/logos/coin-pair.svg"
        title={
          <>
            Get access, privately
          </>
        }
      >
        <p className="mt-4 max-w-[680px] text-[15px] text-fg-muted">
          agUSD is a permissioned share. Your application is encrypted in this browser with ML-KEM-1024 to the
          compliance officer and the auditor, and only ciphertext goes on chain. The decision is signed with
          ML-DSA-87 and checked on chain by QoreChain&apos;s pqcVerify.
        </p>
      </Hero>

      <Panel>
        {!account ? (
          <div className={`${card} text-center`}>
            <p className="text-[15px] text-fg-muted">Connect QoreX to apply. It signs every step with ML-DSA-87.</p>
            <div className="mx-auto mt-4 max-w-[260px]">
              <button type="button" onClick={connect} className={primaryBtn}>
                Connect QoreX
              </button>
            </div>
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-3">
            <KeyStep
              evm={account.evm}
              keys={keys}
              setKeys={setKeys}
              published={published}
              onChainKey={user.encryptionKey}
              publish={() => act.publishKey(keys!.mlkemPublicKey)}
            />
            <ApplyStep
              evm={account.evm}
              ready={published}
              status={status}
              officers={officers.data}
              officersError={officers.error as Error | null}
              file={act.fileDossier}
            />
            <DecisionStep
              evm={account.evm}
              status={status}
              keys={keys}
              expiresAt={user.member?.expiresAt}
              letter={decision.data?.letter}
              tx={decision.data?.tx}
            />
          </div>
        )}

        <Explainer />
      </Panel>
    </>
  );
}

function StepCard({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <div className={`${card} flex flex-col`}>
      <div className="flex items-center gap-3">
        <span
          className={`flex h-8 w-8 items-center justify-center rounded-full text-[14px] font-semibold ${
            done ? 'bg-[#2f7d5b] text-white' : 'bg-[#254839]/[0.08] text-[#254839]'
          }`}
        >
          {done ? <Check className="h-4 w-4" /> : n}
        </span>
        <h2 className="text-[17px] font-semibold text-fg">{title}</h2>
      </div>
      <div className="mt-4 flex flex-1 flex-col">{children}</div>
    </div>
  );
}

function KeyStep({
  evm,
  keys,
  setKeys,
  published,
  onChainKey,
  publish,
}: {
  evm: Hex;
  keys: SealKeyPair | null;
  setKeys: (k: SealKeyPair) => void;
  published: boolean;
  onChainKey?: Hex;
  publish: () => Promise<unknown>;
}) {
  const [restoring, setRestoring] = useState(false);
  const [seed, setSeed] = useState('');
  const [err, setErr] = useState<string>();
  const mismatch = !!keys && !!onChainKey && onChainKey !== '0x' && onChainKey !== toHex(keys.mlkemPublicKey);

  const download = () => {
    if (!keys) return;
    const url = URL.createObjectURL(backupFile(evm, keys));
    const a = document.createElement('a');
    a.href = url;
    a.download = `agama-qoreseal-key-${evm.slice(2, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <StepCard n={1} title="Your encryption key" done={published}>
      <p className="text-[13px] text-fg-muted">
        A QoreSeal key pair, ML-KEM-1024 and X25519, made here. Its secret half never leaves this browser; the public
        half goes on chain, in QoreChain&apos;s KEM registry and in Agama&apos;s, from your QoreX account.
      </p>
      {keys ? (
        <div className="mt-4 rounded-xl bg-[#254839]/[0.05] px-4 py-3 text-[13px]">
          <div className="flex items-center gap-2 text-fg">
            <KeyRound className="h-4 w-4" aria-hidden /> ML-KEM-1024 · {fingerprint(keys.mlkemPublicKey)}…
          </div>
          <div className="mt-1 text-fg-muted">
            {published ? 'Published and bound to your account.' : mismatch ? 'A different key is on chain: publish this one, or restore the old one.' : 'Not on chain yet.'}
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          <button type="button" className={primaryBtn} onClick={() => setKeys(createKeys(evm))}>
            Create my key in this browser
          </button>
          <button type="button" className={secondaryBtn} onClick={() => setRestoring((r) => !r)}>
            Restore from a backup
          </button>
        </div>
      )}
      {restoring && !keys && (
        <div className="mt-3">
          <textarea
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            placeholder="Paste the seed (0x…) from your backup file"
            className="h-20 w-full rounded-xl border border-[#254839]/20 bg-white px-3 py-2 text-[12px] outline-none"
          />
          <button
            type="button"
            className={`mt-2 ${secondaryBtn}`}
            onClick={() => {
              try {
                setKeys(importSeed(evm, seed));
                setErr(undefined);
              } catch {
                setErr('That is not a 32-byte seed.');
              }
            }}
          >
            <Upload className="mr-2 inline h-4 w-4" aria-hidden />
            Restore
          </button>
          <Status error={err} />
        </div>
      )}
      <div className="mt-auto space-y-2 pt-4">
        {keys && !published && <TxButton label="Publish my key (one QoreX signature)" action={publish} />}
        {keys && (
          <button type="button" onClick={download} className="flex w-full items-center justify-center gap-2 text-[13px] text-fg-muted hover:text-fg">
            <Download className="h-4 w-4" aria-hidden /> Download a backup of this key
          </button>
        )}
      </div>
    </StepCard>
  );
}

function ApplyStep({
  evm,
  ready,
  status,
  officers,
  officersError,
  file,
}: {
  evm: Hex;
  ready: boolean;
  status: string;
  officers?: { compliance: Uint8Array; auditor: Uint8Array };
  officersError: Error | null;
  file: (envelope: Hex) => Promise<unknown>;
}) {
  const [f, setF] = useState({
    name: '',
    email: '',
    country: 'FR',
    investorType: 'professional',
    entity: '',
    sourceOfFunds: '',
    notUsPerson: false,
    notSanctioned: false,
    understandsRisk: false,
  });
  const [sealed, setSealed] = useState<Hex>();
  const filed = status === 'Pending' || status === 'Approved';
  const complete = f.name.trim().length > 1 && f.notUsPerson && f.notSanctioned && f.understandsRisk;

  const dossier = useMemo(
    () => ({
      v: 1,
      name: f.name.trim(),
      email: f.email.trim() || undefined,
      country: f.country,
      investorType: f.investorType,
      entity: f.entity.trim() || undefined,
      sourceOfFunds: f.sourceOfFunds.trim() || undefined,
      attestations: { notUsPerson: f.notUsPerson, notSanctioned: f.notSanctioned, understandsRisk: f.understandsRisk },
      declaredAt: new Date().toISOString(),
    }),
    [f],
  );

  const input = 'w-full rounded-xl border border-[#254839]/15 bg-white px-3 py-2.5 text-[14px] outline-none focus:border-[#254839]/40';
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }));

  return (
    <StepCard n={2} title="Your sealed application" done={filed}>
      {filed ? (
        <p className="text-[13px] text-fg-muted">
          Filed. The chain holds it as a QoreSeal envelope only the compliance officer and the auditor can open.
          {status === 'Approved' && ' To update it, file again: your access goes back to review.'}
        </p>
      ) : (
        <>
          <div className="space-y-2.5">
            <input className={input} placeholder="Legal name" value={f.name} onChange={set('name')} />
            <input className={input} placeholder="Email (optional)" value={f.email} onChange={set('email')} />
            <div className="grid grid-cols-2 gap-2.5">
              <select className={input} value={f.country} onChange={set('country')}>
                {COUNTRIES.map(([c, n]) => (
                  <option key={c} value={c}>
                    {n}
                  </option>
                ))}
              </select>
              <select className={input} value={f.investorType} onChange={set('investorType')}>
                <option value="professional">Professional</option>
                <option value="institutional">Institutional</option>
                <option value="accredited-individual">Accredited individual</option>
                <option value="retail">Retail</option>
              </select>
            </div>
            <input className={input} placeholder="Entity (optional)" value={f.entity} onChange={set('entity')} />
            <input className={input} placeholder="Source of funds (optional)" value={f.sourceOfFunds} onChange={set('sourceOfFunds')} />
            {(
              [
                ['notUsPerson', 'I am not a US person'],
                ['notSanctioned', 'I am not subject to sanctions'],
                ['understandsRisk', 'I understand private credit can lose value and exits can queue'],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="flex items-start gap-2 text-[13px] text-fg">
                <input type="checkbox" className="mt-0.5" checked={f[k]} onChange={set(k)} />
                {label}
              </label>
            ))}
          </div>
          {sealed && (
            <div className="mt-3 rounded-xl bg-[#254839] px-4 py-3 text-[12px] text-[#fdf8ed]">
              <div className="flex items-center gap-2 font-medium">
                <Lock className="h-3.5 w-3.5" aria-hidden /> What the chain will see: {kb(sealed)} of ciphertext
              </div>
              <div className="mt-1 break-all font-mono text-[11px] text-[#fdf8ed]/70">{sealed.slice(0, 180)}…</div>
            </div>
          )}
          <div className="mt-auto space-y-2 pt-4">
            {!sealed ? (
              <button
                type="button"
                disabled={!ready || !complete || !officers}
                className={primaryBtn}
                onClick={() => setSealed(sealDossier(evm, [officers!.compliance, officers!.auditor], dossier))}
              >
                {!ready ? 'Publish your key first' : !officers ? (officersError ? 'Officer keys unavailable' : 'Reading officer keys') : 'Seal it in this browser'}
              </button>
            ) : (
              <>
                <TxButton label="File it on chain (one QoreX signature)" action={() => file(sealed)} />
                <button type="button" className="w-full text-[13px] text-fg-muted hover:text-fg" onClick={() => setSealed(undefined)}>
                  Edit before filing
                </button>
              </>
            )}
          </div>
        </>
      )}
    </StepCard>
  );
}

function DecisionStep({
  evm,
  status,
  keys,
  expiresAt,
  letter,
  tx,
}: {
  evm: Hex;
  status: string;
  keys: SealKeyPair | null;
  expiresAt?: bigint;
  letter?: Hex;
  tx?: Hex;
}) {
  const [opened, setOpened] = useState<Letter>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    setOpened(undefined);
    setErr(undefined);
  }, [letter]);

  const open = () => {
    try {
      setOpened(openLetter<Letter>(evm, keys!, letter!));
    } catch {
      setErr('This browser does not hold the key the letter was sealed to. Restore it from your backup.');
    }
  };

  return (
    <StepCard n={3} title="The decision" done={status === 'Approved'}>
      {status === 'None' && <p className="text-[13px] text-fg-muted">Nothing filed yet.</p>}
      {status === 'Pending' && (
        <p className="text-[13px] text-fg-muted">
          In review. The compliance officer opens sealed applications as they arrive, usually within a minute, and
          signs its decision with ML-DSA-87.
        </p>
      )}
      {(status === 'Approved' || status === 'Rejected' || status === 'Revoked') && (
        <>
          <div
            className={`rounded-xl px-4 py-3 text-[14px] font-medium ${
              status === 'Approved' ? 'bg-[#2f7d5b]/10 text-[#2f7d5b]' : 'bg-[#b4571f]/10 text-[#b4571f]'
            }`}
          >
            <ShieldCheck className="mr-2 inline h-4 w-4" aria-hidden />
            {status === 'Approved'
              ? `Approved until ${new Date(Number(expiresAt ?? 0n) * 1000).toLocaleDateString()}`
              : status === 'Rejected'
                ? 'Not approved'
                : 'Access revoked: you can still withdraw everything'}
          </div>
          {letter && !opened && (
            <button type="button" disabled={!keys} onClick={open} className={`mt-3 ${secondaryBtn}`}>
              <Lock className="mr-2 inline h-4 w-4" aria-hidden />
              Open the sealed letter ({kb(letter)})
            </button>
          )}
          {opened && (
            <div className="mt-3 space-y-1.5 rounded-xl bg-[#254839]/[0.05] px-4 py-3 text-[13px]">
              {opened.tierName && <div className="font-medium text-fg">{opened.tierName} investor</div>}
              {opened.reasons.map((r) => (
                <div key={r} className="text-fg">
                  {r}
                </div>
              ))}
              <div className="pt-1 text-[12px] text-fg-muted">
                {opened.reviewer}, {new Date(opened.reviewedAt).toLocaleString()}. Decrypted here with your ML-KEM-1024
                key.
              </div>
            </div>
          )}
          <Status error={err} />
          {tx && (
            <a href={qoreTx(tx)} target="_blank" rel="noreferrer" className="mt-2 text-[12px] text-fg-muted underline-offset-2 hover:underline">
              The decision&apos;s ML-DSA-87 signature, verified on chain
            </a>
          )}
          {status === 'Approved' && (
            <div className="mt-auto flex gap-2 pt-4">
              <Link href="/" className={primaryBtn + ' text-center'}>
                Deposit
              </Link>
              <Link href="/data-room" className={secondaryBtn + ' text-center'}>
                Data room
              </Link>
            </div>
          )}
        </>
      )}
    </StepCard>
  );
}

function Explainer() {
  const rows: [string, string, string][] = [
    ['Your answers', 'ML-KEM-1024 + AES-256-GCM (QoreSeal), sealed in this browser', 'Ciphertext in the AccessRegistry'],
    ['Who can read them', 'The compliance officer and the auditor, by their keys in QoreChain’s KEM registry', 'Nobody else, not the operator'],
    ['Your encryption key', 'Published by a transaction QoreX hybrid-signs (secp256k1 + ML-DSA-87)', 'Refused for an account without a proven ML-DSA-87 key'],
    ['The decision', 'ML-DSA-87 signature of the officer over your dossier’s hash', 'Checked by pqcVerify before the registry accepts it'],
    ['The letter', 'Sealed to you and the auditor, bound to your address', 'Opened only here, with your key'],
    ['What stays public', 'That you applied, when, the envelope size and the outcome', 'By design of QoreSeal'],
  ];
  return (
    <div className={card}>
      <h2 className="text-[13px] uppercase tracking-wider text-fg-muted">What protects what</h2>
      <div className="mt-3 divide-y divide-[#254839]/10 text-[13px]">
        {rows.map(([a, b, c]) => (
          <div key={a} className="grid gap-1 py-2.5 md:grid-cols-[180px_1fr_1fr] md:gap-4">
            <div className="font-medium text-fg">{a}</div>
            <div className="text-fg">{b}</div>
            <div className="text-fg-muted">{c}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
