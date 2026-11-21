'use client';

// A transaction on qorechain-diana, inside Agama: what it did, the post-quantum evidence the chain recorded, and the
// details. The public explorer opens on mainnet, so the toasts, the data room and the access page link here.
import { use, type ReactNode } from 'react';
import { CheckCircle2, ExternalLink, Loader2, XCircle } from 'lucide-react';
import { card, Hero, Panel } from '@/components/ui';
import { QORE_EXPLORER } from '@/lib/chains';
import { useTx } from '@/lib/tx';

const mono = 'font-mono text-[12px] break-all';

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 md:grid-cols-[200px_1fr] md:gap-6">
      <div className="text-[13px] text-fg-muted">{label}</div>
      <div className="min-w-0 text-[14px] text-fg">{children}</div>
    </div>
  );
}

export default function TxPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = use(params);
  const valid = /^(0x)?[0-9a-fA-F]{64}$/.test(hash);
  const { data: tx, error, isLoading } = useTx(valid ? hash : '');

  return (
    <>
      <Hero title="Transaction">
        <p className={`mt-4 max-w-[900px] text-fg-muted ${mono}`}>{hash}</p>
        {tx && (
          <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-[#254839]/[0.06] px-3 py-1.5 text-[13px]">
            {tx.ok ? <CheckCircle2 className="h-4 w-4 text-[#2f7d5b]" aria-hidden /> : <XCircle className="h-4 w-4 text-[#b4571f]" aria-hidden />}
            {tx.ok ? 'Success' : 'Failed'} · block {tx.height.toLocaleString()} · {new Date(tx.time).toLocaleString()}
          </div>
        )}
      </Hero>
      <Panel>
        {!valid && <div className={card}>Not a transaction hash.</div>}
        {valid && isLoading && (
          <div className={`${card} flex items-center gap-2 text-fg-muted`}>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Reading qorechain-diana…
          </div>
        )}
        {error && <div className={`${card} text-[#9b2c2c]`}>{(error as Error).message}</div>}
        {tx && (
          <>
            <div className={card}>
              <h2 className="text-[13px] uppercase tracking-wider text-fg-muted">What it did</h2>
              <div className="mt-3 text-[18px] font-semibold text-fg">{tx.lender ? tx.lender.summary : tx.action ?? tx.messages.join(', ')}</div>
              {tx.lender && tx.lender.calls.length > 1 && (
                <ul className="mt-2 list-disc pl-5 text-[14px] text-fg-muted">
                  {tx.lender.calls.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              )}
              {tx.log && <p className="mt-2 text-[13px] text-[#9b2c2c]">{tx.log}</p>}
            </div>

            <div className={card}>
              <h2 className="text-[13px] uppercase tracking-wider text-fg-muted">Post-quantum evidence</h2>
              <div className="mt-2 divide-y divide-[#254839]/10">
                {tx.lender && (
                  <Line label="Signed by">
                    <div className={mono}>{tx.lender.owner}</div>
                    <div className="mt-1 text-[13px] text-fg-muted">
                      In QoreX, as plain text (secp256k1 + ML-DSA-87). Its Agama account{' '}
                      <span className="font-mono text-[12px]">{tx.lender.account}</span> checked the {tx.lender.sigBytes.toLocaleString()}-byte
                      ML-DSA-87 signature on chain with QoreChain&apos;s pqcVerify precompile
                      {tx.lender.nonce != null ? ` (nonce ${tx.lender.nonce}, so it can never be replayed)` : ''}{' '}before acting. Agama&apos;s relayer
                      only paid the gas.
                    </div>
                  </Line>
                )}
                {tx.hybridVerified && (
                  <Line label="Transaction signature">
                    <strong>secp256k1 + ML-DSA-87, verified by the chain</strong>
                    <div className="mt-1 text-[13px] text-fg-muted">pqc_hybrid_verify, recorded for {tx.sender}</div>
                  </Line>
                )}
                {tx.evmWindow && (
                  <Line label="EVM admission">
                    <strong>Admitted by a post-quantum EVM window</strong>
                    <div className="mt-1 text-[13px] text-fg-muted">
                      {tx.evmWindow.address} opened it with a hybrid-signed transaction; this is transaction {tx.evmWindow.usedTxs} of it.
                    </div>
                  </Line>
                )}
                {!tx.lender && !tx.hybridVerified && !tx.evmWindow && <Line label="Signature">{tx.messages.join(', ')}</Line>}
              </div>
            </div>

            <div className={card}>
              <h2 className="text-[13px] uppercase tracking-wider text-fg-muted">Details</h2>
              <div className="mt-2 divide-y divide-[#254839]/10">
                <Line label="Network">qorechain-diana (testnet)</Line>
                <Line label="Sent by">
                  <span className={mono}>{tx.sender ?? '-'}</span>
                </Line>
                <Line label="Gas used">{tx.gasUsed.toLocaleString()}</Line>
                <Line label="Fee">{tx.feeQor ? `${tx.feeQor.toLocaleString(undefined, { maximumFractionDigits: 6 })} QOR, paid by ${tx.lender ? "Agama's relayer" : 'the sender'}` : '-'}</Line>
                <Line label="Messages">{tx.messages.join(', ')}</Line>
                <Line label="QoreChain hash">
                  <span className={mono}>{tx.cosmosHash}</span>
                </Line>
                {tx.evmHash && (
                  <Line label="EVM hash">
                    <span className={mono}>{tx.evmHash}</span>
                  </Line>
                )}
              </div>
              <p className="mt-4 text-[13px] text-fg-muted">
                Also on the{' '}
                <a href={`${QORE_EXPLORER}/tx/${tx.cosmosHash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-fg underline underline-offset-2">
                  QoreChain explorer <ExternalLink className="h-3 w-3" aria-hidden />
                </a>{' '}
                (switch it to <b>Testnet</b> once, top right; it remembers).
              </p>
            </div>
          </>
        )}
      </Panel>
    </>
  );
}
