import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { AppFrame } from '@/components/AppFrame';
import { Providers } from './providers';

// Self-hosted (latin subset, variable weight): the build never depends on reaching Google Fonts, which failed CI
// runs at random. Inter and Space Grotesk are under the SIL Open Font License.
const inter = localFont({ src: './fonts/inter-latin.woff2', weight: '100 900', variable: '--font-sans', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Agama on QoreChain', template: 'Agama | %s' },
  description: 'agUSD: private credit for permissioned lenders, sealed against Q-Day.',
  metadataBase: new URL('https://app.agama.finance/qorechain/'),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className="min-h-screen bg-bg text-fg antialiased" suppressHydrationWarning>
        <Providers>
          <AppFrame>{children}</AppFrame>
        </Providers>
      </body>
    </html>
  );
}
