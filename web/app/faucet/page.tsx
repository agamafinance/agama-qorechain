'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { TxButton } from '@/components/TxButton';
import { fmt } from '@/lib/format';
import { KeyNotice, useKeyReady } from '@/components/KeyNotice';
import { useActions, useUser } from '@/lib/protocol';
import { asset } from '@/lib/asset';

export default function FaucetPage() {
  const user = useUser();
  const address = user.address;
  const act = useActions();

  const usdc = user.usdc;
  // Minting is one signed message: no gas, no QOR. It only waits on the account's post-quantum key.
  const ready = useKeyReady();

  return (
    <>
      {/* Hero, same language as the Earn page */}
      <section className="px-6 md:px-24 pt-10 md:pt-14 pb-8">
        <div className="max-w-[1400px] mx-auto relative">
          <div aria-hidden className="pointer-events-none absolute right-4 top-2 z-20 hidden lg:block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={asset('/logos/usdc.svg')}
              alt=""
              className="h-[170px] w-[170px] drop-shadow-[0_18px_30px_rgba(20,50,35,0.25)]"
            />
          </div>

          <h1 className="mt-3 text-[34px] md:text-[44px] leading-[1.05] text-fg font-semibold">
            Get USDC
          </h1>
          <p className="mt-4 max-w-[640px] text-[15px] text-fg-muted">
            Agama runs on test money: mock USDC, as much as you like, free. Claim it here, then deposit it on Earn.
            Every action is one signature in QoreX, and Agama pays the gas: you need no QOR.
          </p>

          <div className="mt-7 flex flex-wrap gap-8">
            <Stat label="Asset" value="Mock USDC" />
            <Stat label="Your USDC" value={usdc !== undefined ? fmt(usdc) : '-'} />
          </div>
        </div>
      </section>

      {/* The two faucets, row style, like the vault list */}
      <section className="vault-panel relative z-10 rounded-t-[20px] px-6 md:px-24 pt-10 md:pt-14 pb-24">
        <div className="max-w-[1400px] mx-auto space-y-3">
          <h2 className="text-[13px] uppercase tracking-wider text-fg-muted mb-2">Faucets</h2>

          <KeyNotice className="mb-3" />
          <StepRow
            icon="/logos/usdc.svg"
            title="Mint mock USDC"
            blurb={
              !address
                ? 'Connect QoreX first. 10,000 mock USDC per click, as often as you like.'
                : !ready
                  ? 'Your QoreX account needs its post-quantum key first (see above).'
                  : '10,000 mock USDC per click, as often as you like. One signature, no gas.'
            }
          >
            <TxButton
              fit
              label="Get 10,000 USDC"
              disabled={!address || !ready}
              action={act.faucet}
            />
          </StepRow>

          {/* Next step */}
          <Link href="/" className="group mt-6 flex items-center gap-4 rounded-2xl bg-[#254839] px-5 py-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={asset('/logos/agusd.svg')} alt="" className="h-10 w-10" />
            <div>
              <div className="text-[15px] font-medium text-[#fdf8ed]">Got your USDC? Deposit it</div>
              <div className="text-[13px] text-[#fdf8ed]/70">Get verified and deposit on Earn, in one card</div>
            </div>
            <ArrowRight className="ml-auto h-5 w-5 text-[#fdf8ed]/80 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[12px] uppercase tracking-wider text-fg-muted">{label}</div>
      <div className="text-[26px] text-fg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function StepRow({
  icon,
  title,
  blurb,
  children,
}: {
  /** Every step has a mark of its own. None of them is numbered: the order is the order they are in, and the
      list changes length as steps fall away. */
  icon: string;
  title: string;
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl bg-[#fdfaf1] px-5 py-4 shadow-[0_1px_3px_rgba(20,50,35,0.06),0_10px_30px_rgba(20,50,35,0.09)] md:flex-row md:items-center">
      <span className="relative h-10 w-10 shrink-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={asset(icon)} alt="" className="h-10 w-10" />
      </span>
      <div className="min-w-0">
        <div className="text-[15px] text-fg font-medium">{title}</div>
        <div className="text-[13px] text-fg-muted break-words">{blurb}</div>
      </div>
      <div className="md:ml-auto shrink-0">{children}</div>
    </div>
  );
}
