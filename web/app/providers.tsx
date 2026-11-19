'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode, useState } from 'react';
import { WalletProvider } from '@/lib/wallet';
import { ToastProvider } from '@/components/Toasts';

export function Providers({ children }: { children: ReactNode }) {
  // networkMode 'always': navigator.onLine is a guess about a network adapter, not about whether an RPC answers.
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { networkMode: 'always', staleTime: 4_000 } } }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <WalletProvider>
        <ToastProvider>{children}</ToastProvider>
      </WalletProvider>
    </QueryClientProvider>
  );
}
