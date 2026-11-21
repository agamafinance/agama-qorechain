import { createPublicClient, defineChain, fallback, http } from 'viem';
import { sepolia } from 'viem/chains';

/// QoreChain's testnet, qorechain-diana, seen from its EVM lane (chain id 9800). Every native transaction on it is
/// hybrid-signed, secp256k1 and ML-DSA-87, and the chain checks both.
export const COSMOS_CHAIN_ID = 'qorechain-diana';
export const EVM_RPC = process.env.NEXT_PUBLIC_QORE_EVM ?? 'https://evm-testnet.qore.host';
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '/qorechain';
/// The browser reads QoreChain's REST API through this app's own proxy: the public endpoint sends no CORS headers.
export const REST = `${BASE}/api/rest`;

export const diana = defineChain({
  id: 9800,
  name: 'QoreChain Diana',
  nativeCurrency: { name: 'QOR', symbol: 'QOR', decimals: 18 },
  rpcUrls: { default: { http: [EVM_RPC] } },
  blockExplorers: { default: { name: 'QoreChain Explorer', url: 'https://explore.qore.network' } },
  testnet: true,
});

export { sepolia };

export const QORE_EXPLORER = 'https://explore.qore.network';
export const ETH_EXPLORER = 'https://sepolia.etherscan.io';
export const QOR_FAUCET = 'https://dashboard.qorechain.io/faucet';
export const QOREX_INSTALL = 'https://docs.qorechain.io/qorex/browser-extension';

export const qoreAddress = (a: string) => `${QORE_EXPLORER}/address/${a}`;
/// Transactions open on Agama's own page (app/tx): the public explorer opens on mainnet, these are on testnet.
export const qoreTx = (h: string) => `${BASE}/tx/${h}`;
export const ethAddress = (a: string) => `${ETH_EXPLORER}/address/${a}`;
export const ethTx = (h: string) => `${ETH_EXPLORER}/tx/${h}`;

/// QoreChain has no multicall contract, so reads are batched at the JSON-RPC level instead. Its endpoint sits behind
/// Cloudflare, which answers bursts with 1015: one retry, and react-query's next refetch is the next one.
export const qore = createPublicClient({
  chain: diana,
  transport: http(EVM_RPC, { batch: { batchSize: 12, wait: 16 }, retryCount: 1, timeout: 20_000 }),
});

/// Ethereum is only ever read: nobody signs on the L1 from this app, the keeper does.
export const l1 = createPublicClient({
  chain: sepolia,
  batch: { multicall: true },
  transport: fallback(
    [
      http('https://ethereum-sepolia-rpc.publicnode.com', { batch: true, retryCount: 0, timeout: 15_000 }),
      http('https://sepolia.drpc.org', { batch: true, retryCount: 0, timeout: 15_000 }),
      http('https://11155111.rpc.thirdweb.com', { batch: true, retryCount: 0, timeout: 15_000 }),
    ],
    { retryCount: 0 },
  ),
});
