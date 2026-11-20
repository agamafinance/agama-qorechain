'use client';

// The one thing a lender's Agama account needs: the ML-DSA-87 key of its QoreX account, registered on QoreChain.
// QoreX registers it with the account's first transaction; until then, the account cannot sign for Agama. Renders
// nothing once the key is there, which is the case for nearly every QoreX account.
import { usePqKey } from '@/lib/protocol';
import { useWallet } from '@/lib/wallet';
import { QOR_FAUCET } from '@/lib/chains';

export function useKeyReady() {
  return usePqKey().data === true;
}

export function KeyNotice({ className = '' }: { className?: string }) {
  const { account } = useWallet();
  const key = usePqKey();
  if (!account || key.data !== false) return null;
  return (
    <div className={`rounded-xl bg-[#b4571f]/10 px-4 py-3 text-[13px] text-fg ${className}`}>
      <div className="font-medium">Your QoreX account has no post-quantum key on chain yet</div>
      <div className="mt-1 text-fg-muted">
        Agama needs the ML-DSA-87 key QoreX registers with your first transaction. Take QOR from the{' '}
        <a href={QOR_FAUCET} target="_blank" rel="noreferrer" className="underline underline-offset-2">QoreChain faucet</a> and send any
        transaction from QoreX (a small transfer to yourself is enough). This page notices by itself.
      </div>
    </div>
  );
}
