'use client';

import { useState } from 'react';
import { short } from '@/lib/format';
import { useWallet } from '@/lib/wallet';
import { QOREX_INSTALL } from '@/lib/chains';

const pill =
  'pill-outline flex h-10 items-center gap-2 rounded-full px-[14px] sm:px-[17px] text-[14px] font-medium whitespace-nowrap text-white';

/// QoreX, in the app's own pill. No other wallet: on QoreChain only QoreX adds the ML-DSA-87 signature the chain
/// requires, so offering another would be offering a wallet that cannot sign here.
export function ConnectPill() {
  const { account, installed, connecting, connect, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  if (installed === false && !account) {
    return (
      <a href={QOREX_INSTALL} target="_blank" rel="noreferrer" className={pill}>
        Get QoreX
      </a>
    );
  }
  if (!account) {
    return (
      <button type="button" onClick={connect} disabled={connecting} className={pill}>
        <span>{connecting ? 'Connecting…' : <>Connect<span className="hidden sm:inline"> QoreX</span></>}</span>
      </button>
    );
  }
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className={pill} title={account.address}>
        {short(account.address)}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-[260px] rounded-2xl bg-[#fdfaf1] p-4 text-[#254839] shadow-[0_10px_30px_rgba(20,50,35,0.18)] z-50">
          <div className="text-[12px] uppercase tracking-wider opacity-60">QoreX account</div>
          <div className="mt-1 break-all text-[13px]">{account.address}</div>
          <div className="mt-2 text-[12px] uppercase tracking-wider opacity-60">EVM twin</div>
          <div className="mt-1 break-all text-[13px]">{account.evm}</div>
          <button
            type="button"
            onClick={() => {
              disconnect();
              setOpen(false);
            }}
            className="mt-3 h-9 w-full rounded-full bg-[#254839]/[0.08] text-[13px] hover:bg-[#254839]/[0.16]"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
