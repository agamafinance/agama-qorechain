'use client';

// Earn.
//
// agUSD is the ERC-4626 share, so the yield is already in its price and depositing is the whole action. On
// QoreChain the share is permissioned: only a lender the compliance officer approved, holding a proven ML-DSA-87
// key, may receive it. Every deposit and exit is one QoreX transaction, hybrid-signed.
import { useState } from 'react';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { AmountBox, card, Hero, Panel, primaryBtn, Row, Segmented, Stat, Status, Step } from '@/components/ui';
import { NavChart } from '@/components/NavChart';
import { Route } from '@/components/Route';
import { CreditVaults } from '@/components/CreditVaults';
import { BridgeSecurity } from '@/components/BridgeSecurity';
import { DASH, fmt, parse, raw, usd } from '@/lib/format';
import { netApy, precisePrice, useActions, useActivity, useBook, useUser, useVault } from '@/lib/protocol';
import { useWallet } from '@/lib/wallet';
import { ETHEREUM } from '@/lib/deployments';

type Side = 'deposit' | 'withdraw';

export default function EarnPage() {
  const { connect } = useWallet();
  const { vault, totalSent, totalReturned, error, isFetching, refetch } = useVault();
  const { data: book } = useBook();
  const { data: activity } = useActivity();
  const user = useUser();
  const act = useActions();

  const [side, setSide] = useState<Side>('deposit');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text?: string; error?: string }>();

  const inflight =
    book && totalSent !== undefined && totalReturned !== undefined
      ? totalSent - ETHEREUM.sentBase - book.received + (book.sentHome - (totalReturned - ETHEREUM.returnedBase))
      : undefined;

  const price = vault?.sharePrice ?? 1_000_000n;
  const sp = precisePrice(vault) ?? Number(price) / 1e6;
  const apyPct = netApy(vault);
  const apy = apyPct === undefined ? DASH : `${apyPct.toFixed(2)}%`;

  const amt = parse(amount);
  const balance = side === 'deposit' ? user.usdc : user.agusd;
  const unit = side === 'deposit' ? 'USDC' : 'agUSD';
  const shares = amt > 0n ? (amt * 1_000_000n) / price : 0n;
  const assets = amt > 0n ? (amt * price) / 1_000_000n : 0n;
  const enough = balance !== undefined && amt > 0n && amt <= balance;

  // Above the buffer, an exit queues instead of failing. Say which one this will be before the click, not after.
  const instant = side === 'withdraw' && user.maxRedeem !== undefined && amt <= user.maxRedeem;
  const allowed = user.eligible === true;
  const blocked = side === 'deposit' && !!user.address && user.eligible === false;

  async function run(label: string, fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setStatus({ text: label });
    try {
      await fn();
      setStatus({ text: done });
      setAmount('');
    } catch (e) {
      const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : 'Transaction failed';
      setStatus({ error: msg });
    } finally {
      setBusy(false);
    }
  }

  const go = () => {
    if (!user.address) return;
    if (side === 'deposit') {
      return run('Signing in QoreX', () => act.deposit(amt, user.allowance ?? 0n), 'Done. Your agUSD is earning.');
    }
    return instant
      ? run(
          'Signing in QoreX',
          () =>
            act.redeem(amt).catch((e) => {
              // An exit queued by someone else a block earlier settles from the buffer first (first in, first out),
              // so an instant withdrawal can find it gone. Say so: the button now offers to queue.
              throw new Error(
                /revert|failed on chain/i.test(String((e as Error).message))
                  ? 'The buffer was just used by exits queued before yours. Your agUSD is untouched: queue the withdrawal instead.'
                  : (e as Error).message,
              );
            }),
          'Done. USDC is in your wallet.',
        )
      : run('Signing in QoreX', () => act.requestRedeem(amt), 'Queued at today’s price. It pays as cash comes home.');
  };

  const stalled = !vault && !!error;
  const label = !user.address
    ? 'Connect QoreX'
    : !vault
      ? stalled ? 'QoreChain did not answer' : 'Reading the vault'
      : blocked
        ? 'Get access first'
      : amt === 0n
        ? 'Enter an amount'
        : !enough
          ? side === 'deposit' ? 'Not enough USDC, see the Faucet' : 'Not enough agUSD'
          : side === 'deposit'
            ? 'Deposit and start earning'
            : instant ? 'Withdraw now' : 'Queue the withdrawal';

  return (
    <>
      <Hero
        art="/logos/coin-pair.svg"
        title={
          <>
            Private credit yield,
            <br />
            sealed against Q-Day
          </>
        }
      >
        <p className="mt-4 max-w-[660px] text-[15px] text-fg-muted">
          A permissioned vault for approved lenders. Your KYC and the loan tape stay encrypted with ML-KEM-1024, and
          every key that can move the money signs with ML-DSA-87.
        </p>
        <div className="mt-7 flex flex-wrap gap-8">
          <Stat label="Net APY" value={apy} sub="Target, after fee and buffer" />
          <Stat label="Vault assets" value={usd(vault?.totalAssets, 0)} sub="USDC backing agUSD" />
          <Stat label="agUSD price" value={sp.toFixed(8)} sub="In USDC, assets over supply, live" />
          <Stat label="On the book" value={usd(book?.offChain, 0)} sub="Funded off chain, ABF senior" />
        </div>
      </Hero>

      <Panel>
        <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
          <NavChart
            price={vault ? sp : undefined}
            nav={vault?.totalAssets}
            apy={apyPct}
            failed={stalled ? (error as Error).message : null}
            retrying={isFetching}
            onRetry={() => refetch()}
            marks={activity?.navs.map((n) => ({ ts: n.ts, price: Number(n.price) / 1e6 })).sort((a, b) => a.ts - b.ts)}
          />

          <div className={`${card} flex flex-col`}>
            <div className="flex items-center justify-between">
              <h2 className="text-[17px] font-semibold text-fg">
                {side === 'deposit' ? 'Deposit USDC' : 'Withdraw USDC'}
              </h2>
              {vault?.paused && (
                <span className="rounded-full bg-[#b4571f]/10 px-3 py-1 text-[12px] text-[#b4571f]">Paused</span>
              )}
            </div>

            <Segmented
              value={side}
              onChange={(v) => {
                setSide(v);
                setAmount('');
                setStatus(undefined);
              }}
              options={[['deposit', 'Deposit'], ['withdraw', 'Withdraw']] as const}
            />

            <p className="mt-2 text-[12px] text-fg-muted">
              {side === 'deposit'
                ? 'One QoreX signature, secp256k1 and ML-DSA-87: the approval, if needed, and the deposit travel together.'
                : `Instant up to the buffer, ${usd(vault?.liquid)} right now. Above it, the exit burns your agUSD at today’s price and joins a first in, first out queue.`}
            </p>

            <AmountBox
              label={side === 'deposit' ? 'Deposit' : 'Withdraw'}
              balanceLabel={fmt(balance)}
              canMax={balance !== undefined && balance > 0n}
              onMax={() => balance !== undefined && setAmount(raw(balance))}
              value={amount}
              onChange={setAmount}
              unit={unit}
              hint={`1 agUSD = ${sp.toFixed(6)} USDC`}
            />

            <dl className="mt-4 space-y-2 text-[13px]">
              {side === 'deposit' ? (
                <>
                  <Row label="agUSD you receive" value={shares > 0n ? fmt(shares, 4) : DASH} />
                  <Row label="Yield on it" value={apyPct === undefined ? DASH : `${apy} a year, in the price`} />
                  <Row label="Lock" value="None" />
                </>
              ) : (
                <>
                  <Row label="USDC you get back" value={assets > 0n ? fmt(assets, 4) : DASH} />
                  <Row
                    label="How"
                    value={amt === 0n ? DASH : instant ? 'Now, from the buffer' : 'Queued, paid as cash comes home'}
                  />
                  <Row label="Working on the book" value={usd(vault?.deployed)} />
                </>
              )}
            </dl>

            {blocked ? (
              <Link href="/access" className={`mt-4 ${primaryBtn} flex items-center justify-center gap-2`}>
                <ShieldCheck className="h-4 w-4" aria-hidden />
                {user.member?.status === 'Pending' ? 'Application in review' : 'Get access to deposit'}
              </Link>
            ) : (
              <button
                onClick={user.address ? go : connect}
                disabled={busy || (!!user.address && (!enough || !!vault?.paused || (side === 'deposit' && !allowed)))}
                className={`mt-4 ${primaryBtn}`}
              >
                {busy ? <Step text={status?.text} /> : label}
              </button>
            )}
            {!busy && <Status text={status?.text} error={status?.error} />}

            <p className="mt-auto pt-4 text-[12px] text-fg-muted">
              Need mock USDC or QOR for gas?{' '}
              <Link href="/faucet" className="underline hover:text-fg">The faucet tab</Link>. Queued exits and what you
              hold are on{' '}
              <Link href="/portfolio" className="underline hover:text-fg">the Portfolio tab</Link>.
            </p>
          </div>
        </div>

        <Route vault={vault} book={book} inflight={inflight} />

        <BridgeSecurity />

        <CreditVaults deployed={vault?.deployed} />
      </Panel>
    </>
  );
}
