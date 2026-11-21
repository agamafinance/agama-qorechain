'use client';

// The one thing a lender's Agama account needs: the ML-DSA-87 key of its QoreX account, registered on QoreChain.
// QoreX registers it with the account's first transaction; until then, the account cannot sign for Agama. The notice
// offers that first transaction (one micro-QOR to itself) when the account holds QOR, the faucet when it does not,
// and renders nothing once the key is there, which is the case for nearly every QoreX account.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePqKey } from '@/lib/protocol';
import { useWallet } from '@/lib/wallet';
import { QOR_FAUCET, REST } from '@/lib/chains';
import { bankSend } from '@/lib/proto';
import { signAndBroadcast } from '@/lib/qorex';

export function useKeyReady() {
  return usePqKey().data === true;
}

function useQor(address?: string) {
  return useQuery({
    queryKey: ['qor', address],
    enabled: !!address,
    refetchInterval: 10_000,
    queryFn: async () => {
      const r = await fetch(`${REST}/cosmos/bank/v1beta1/balances/${address}`);
      const b = (await r.json()) as { balances?: { denom: string; amount: string }[] };
      return BigInt(b.balances?.find((c) => c.denom === 'uqor')?.amount ?? '0');
    },
  });
}

export function KeyNotice({ className = '' }: { className?: string }) {
  const { account } = useWallet();
  const key = usePqKey();
  const qor = useQor(account?.address);
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!account || key.data !== false) return null;
  const funded = (qor.data ?? 0n) >= 50_000n;

  const activate = async () => {
    setErr(null);
    setBusy(true);
    try {
      await signAndBroadcast([bankSend(account.address, account.address, 1n)], 'Agama: register my post-quantum key', 200_000);
      await client.invalidateQueries({ queryKey: ['pqkey'] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`rounded-xl bg-[#b4571f]/10 px-4 py-3 text-[13px] text-fg ${className}`}>
      <div className="font-medium">Your QoreX account has no post-quantum key on chain yet</div>
      <div className="mt-1 text-fg-muted">
        {funded ? (
          <>QoreX registers your ML-DSA-87 key with your first transaction. One click sends 0.000001 QOR to yourself, and the key is on chain.</>
        ) : (
          <>
            QoreX registers your ML-DSA-87 key with your first transaction, which needs a little QOR. Take some from the{' '}
            <a href={QOR_FAUCET} target="_blank" rel="noreferrer" className="underline underline-offset-2">QoreChain faucet</a> (Testnet) for{' '}
            <span className="font-mono text-[12px]">{account.address}</span>. This page notices by itself.
          </>
        )}
      </div>
      {funded && (
        <button
          type="button"
          onClick={activate}
          disabled={busy}
          className="mt-2 rounded-full bg-[#254839] px-4 py-1.5 text-[13px] text-white hover:opacity-90 disabled:opacity-45"
        >
          {busy ? 'Confirm in QoreX…' : 'Register my key from QoreX'}
        </button>
      )}
      {err && <div className="mt-2 text-[12px] text-[#b4571f]">{err}</div>}
    </div>
  );
}
