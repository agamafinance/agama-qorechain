'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { connectQorex, qorexEvm, waitForQorex, type Account } from './qorex';

type WalletState = {
  account: Account | null;
  installed: boolean | null;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
};

const Ctx = createContext<WalletState | null>(null);
const STORAGE = 'agama-qore:connected';

export function WalletProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void waitForQorex(2000).then(async (n) => {
      if (!alive) return;
      setInstalled(Boolean(n));
      // Reconnect silently if this site was connected before.
      if (n && localStorage.getItem(STORAGE)) {
        try {
          setAccount(await connectQorex());
        } catch {
          localStorage.removeItem(STORAGE);
        }
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      if (!qorexEvm()) {
        setInstalled(false);
        throw new Error('Install QoreX to use Agama.');
      }
      const acc = await connectQorex();
      localStorage.setItem(STORAGE, '1');
      setAccount(acc);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    localStorage.removeItem(STORAGE);
    setAccount(null);
  }, []);

  const value = useMemo(
    () => ({ account, installed, connecting, error, connect, disconnect }),
    [account, installed, connecting, error, connect, disconnect],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWallet outside WalletProvider');
  return v;
}
