/**
 * The two chains of the route and their public endpoints.
 *
 * QoreChain's EVM endpoint sits behind Cloudflare, which answers bursts with error 1015: every client here retries
 * slowly, and scans read at most 10,000 blocks per query, the node's own limit.
 */
import { createPublicClient, defineChain, fallback, http } from "viem";
import { sepolia } from "viem/chains";

export const CHAIN_ID = "qorechain-diana";
export const REST = process.env.QORE_REST_URL ?? "https://api-testnet.qore.host";
export const RPC = process.env.QORE_RPC_URL ?? "https://rpc-testnet.qore.host";
export const EVM_RPC = process.env.QORE_EVM_URL ?? "https://evm-testnet.qore.host";
export const EXPLORER = "https://explore.qore.network";

export const diana = defineChain({
  id: 9800,
  name: "QoreChain Diana",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [EVM_RPC] } },
  blockExplorers: { default: { name: "QoreChain Explorer", url: EXPLORER } },
  testnet: true,
});

const SEPOLIA_RPCS = [
  process.env.SEPOLIA_RPC_URL,
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.drpc.org",
  "https://11155111.rpc.thirdweb.com",
].filter(Boolean) as string[];

export const qore = createPublicClient({
  chain: diana,
  transport: http(EVM_RPC, { retryCount: 5, retryDelay: 2_000, timeout: 30_000 }),
});

export const sepoliaTransport = () =>
  fallback(SEPOLIA_RPCS.map((u) => http(u, { retryCount: 2, retryDelay: 1_500, timeout: 20_000 })));

export const eth = createPublicClient({ chain: sepolia, transport: sepoliaTransport() });

export { sepolia };

/** Cosmos REST GET, with a user agent Cloudflare lets through and a slow retry on rate limits. */
export async function rest<T>(path: string): Promise<T> {
  for (let i = 0; ; i++) {
    const res = await fetch(`${REST}${path}`, { headers: { "user-agent": "curl/8.7.1", accept: "application/json" } });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 404) throw Object.assign(new Error(`404 ${path}`), { status: 404 });
    if (i >= 4) throw new Error(`${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 2_000 * (i + 1)));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
