'use client';

// Every read the app makes, and every write.
//
// QoreChain is read through a plain viem client (JSON-RPC batched: the chain has no multicall contract), Ethereum
// through another. Every write is a native QoreChain transaction that QoreX hybrid-signs (secp256k1 + ML-DSA-87)
// and that reaches Agama's contracts through MsgCrossVMCall. The chain does not index the EVM logs of those calls,
// so everything a lender's own action changes is read back from contract state, never from logs; the logs read
// here are the keeper's, sent on the EVM lane.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { encodeFunctionData, maxUint256, parseAbiItem, toHex, type Address, type Hex } from 'viem';
import {
  AbfAssetIssuerAbi,
  AccessRegistryAbi,
  AgamaL1ReceiverAbi,
  AgUSDAbi,
  CrossChainAllocatorAbi,
  DataRoomAbi,
  FestUsdOnRampAbi,
  MockUSDCAbi,
} from '@abi';
import { ETHEREUM, QORECHAIN } from './deployments';
import { fmt } from './format';
import { useToasts } from '@/components/Toasts';
import { COSMOS_CHAIN_ID, l1, qore, REST } from './chains';
import { verifyRecipientCard, type RecipientCard, type SealRecipient } from '@qorechain/qoreseal';
import cards from '../../deployments/recipient-cards.json';
import { convertCoin, crossVmCall, registerKemKey, type EncodedMsg } from './proto';
import { signAndBroadcast } from './qorex';
import { useWallet } from './wallet';

const REFRESH = 8_000;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

/// The book's target rate, the ABF partner's senior sleeve.
export const BOOK_APR_BPS = 900;

export type VaultState = {
  totalAssets: bigint;
  totalSupply: bigint;
  sharePrice: bigint;
  idle: bigint;
  deployed: bigint;
  pending: bigint;
  unvested: bigint;
  liquid: bigint;
  depositCap: bigint;
  reserveBps: number;
  performanceFeeBps: number;
  lastReport: bigint;
  queueLength: bigint;
  paused: boolean;
};

const read = <T,>(address: Address, abi: any, functionName: string, args: unknown[] = []) =>
  qore.readContract({ address, abi, functionName, args } as any) as Promise<T>;

export function useVault() {
  const q = useQuery({
    queryKey: ['vault'],
    refetchInterval: REFRESH,
    queryFn: async () => {
      const [snap, totalSent, totalReturned, config] = await Promise.all([
        read<VaultState>(QORECHAIN.vault, AgUSDAbi, 'snapshot'),
        read<bigint>(QORECHAIN.allocator, CrossChainAllocatorAbi, 'totalSent'),
        read<bigint>(QORECHAIN.allocator, CrossChainAllocatorAbi, 'totalReturned'),
        read<readonly [bigint, number, number, number, number, number, Address]>(QORECHAIN.vault, AgUSDAbi, 'config'),
      ]);
      return { snap, totalSent, totalReturned, config };
    },
  });
  const d = q.data;
  return {
    ...q,
    vault: d?.snap,
    totalSent: d?.totalSent,
    totalReturned: d?.totalReturned,
    config: d
      ? {
          depositCap: d.config[0],
          reserveBps: d.config[1],
          performanceFeeBps: d.config[2],
          maxNavChangeBps: d.config[3],
          minReportInterval: d.config[4],
          profitVestingPeriod: d.config[5],
          feeRecipient: d.config[6],
        }
      : undefined,
  };
}

/// The share price past its sixth decimal: assets over supply, both read on chain.
export function precisePrice(v?: VaultState): number | undefined {
  if (!v) return undefined;
  if (v.totalSupply === 0n) return 1;
  return Number(v.totalAssets) / Number(v.totalSupply);
}

/// Net of the performance fee and of the buffer that earns nothing, so the figure is what a holder gets.
export function netApy(v?: VaultState): number | undefined {
  if (!v) return undefined;
  const working = v.totalAssets > 0n ? Number(v.deployed) / Number(v.totalAssets) : 0.9;
  return (BOOK_APR_BPS / 100) * Math.min(1, working) * (1 - v.performanceFeeBps / 10_000);
}

export const STATUS = ['None', 'Pending', 'Approved', 'Rejected', 'Revoked'] as const;
export type AccessStatus = (typeof STATUS)[number];

export type Member = {
  status: AccessStatus;
  tier: number;
  filedAt: bigint;
  decidedAt: bigint;
  expiresAt: bigint;
  decidedBlock: bigint;
  dossierHash: Hex;
};

async function bank(address: string): Promise<{ qor: bigint; fusd: bigint }> {
  const r = await fetch(`${REST}/cosmos/bank/v1beta1/balances/${address}`);
  if (!r.ok) return { qor: 0n, fusd: 0n };
  const b = (await r.json()) as { balances?: { denom: string; amount: string }[] };
  const of = (d: string) => BigInt(b.balances?.find((x) => x.denom === d)?.amount ?? '0');
  return { qor: of('uqor'), fusd: of(`erc20:${QORECHAIN.fusd}`) };
}

/// The connected lender: balances, permission and the keys it has published.
export function useUser() {
  const { account } = useWallet();
  const a = account?.evm ?? ZERO;
  const q = useQuery({
    queryKey: ['user', a],
    enabled: !!account,
    refetchInterval: REFRESH,
    queryFn: async () => {
      const [usdc, agusd, allowance, maxWithdraw, maxRedeem, eligible, m, key, b, fusdErc20] = await Promise.all([
        read<bigint>(QORECHAIN.usdc, MockUSDCAbi, 'balanceOf', [a]),
        read<bigint>(QORECHAIN.vault, AgUSDAbi, 'balanceOf', [a]),
        read<bigint>(QORECHAIN.usdc, MockUSDCAbi, 'allowance', [a, QORECHAIN.vault]),
        read<bigint>(QORECHAIN.vault, AgUSDAbi, 'maxWithdraw', [a]),
        read<bigint>(QORECHAIN.vault, AgUSDAbi, 'maxRedeem', [a]),
        read<boolean>(QORECHAIN.access, AccessRegistryAbi, 'isEligible', [a]),
        read<readonly [number, number, bigint, bigint, bigint, bigint, Hex]>(QORECHAIN.access, AccessRegistryAbi, 'members', [a]),
        read<Hex>(QORECHAIN.access, AccessRegistryAbi, 'encryptionKey', [a]),
        bank(account!.address),
        read<bigint>(QORECHAIN.fusd, MockUSDCAbi, 'balanceOf', [a]),
      ]);
      const qor = b.qor;
      // fUSD as the faucet pays it (bank form) plus any already converted to ERC-20 on the 0x twin.
      const fusd = b.fusd + fusdErc20;
      const member: Member = {
        status: STATUS[m[0]] ?? 'None',
        tier: m[1],
        filedAt: m[2],
        decidedAt: m[3],
        expiresAt: m[4],
        decidedBlock: m[5],
        dossierHash: m[6],
      };
      return { usdc, agusd, allowance, maxWithdraw, maxRedeem, eligible, member, encryptionKey: key, qor, fusd, fusdBank: b.fusd, fusdErc20 };
    },
  });
  return { ...q, ...(q.data ?? {}), address: account?.evm, account };
}

export type Book = {
  position: bigint;
  notes: bigint;
  received: bigint;
  sentHome: bigint;
  cash: bigint;
  offChain: bigint;
  issuerAssets: bigint;
  navUpdatedAt: bigint;
  maxOffChainBps: number;
};

/// The Ethereum side: the receiver's position and the issuer's book.
export function useBook() {
  return useQuery({
    queryKey: ['book'],
    refetchInterval: 15_000,
    queryFn: async (): Promise<Book> => {
      const r = { address: ETHEREUM.receiver, abi: AgamaL1ReceiverAbi } as const;
      const i = { address: ETHEREUM.issuer, abi: AbfAssetIssuerAbi } as const;
      const [position, notes, received, sentHome, cash, offChain, issuerAssets, navUpdatedAt, maxOffChainBps] =
        await l1.multicall({
          allowFailure: false,
          contracts: [
            { ...r, functionName: 'positionValue' },
            { ...r, functionName: 'noteBalance' },
            { ...r, functionName: 'totalReceived' },
            { ...r, functionName: 'totalSentHome' },
            { ...i, functionName: 'cash' },
            { ...i, functionName: 'offChainAssets' },
            { ...i, functionName: 'totalAssets' },
            { ...i, functionName: 'navUpdatedAt' },
            { ...i, functionName: 'maxOffChainBps' },
          ],
        });
      return { position, notes, received, sentHome, cash, offChain, issuerAssets, navUpdatedAt, maxOffChainBps };
    },
  });
}

// ---------------------------------------------------------------------------
// History, read off the keeper's logs
// ---------------------------------------------------------------------------

const NavReported = parseAbiItem(
  'event NavReported(uint256 previous, uint256 current, uint256 feeShares, uint256 totalAssets, uint256 sharePrice)',
);
const Allocated = parseAbiItem('event Allocated(uint256 amount, bytes32 indexed remoteReceiver, uint256 totalSent)');
const ReturnSettled = parseAbiItem('event ReturnSettled(bytes32 indexed nonce, uint256 amount, uint256 totalReturned)');
const OffRamped = parseAbiItem('event OffRamped(uint256 amount, address indexed custody, bytes32 indexed wireRef)');
const OnRamped = parseAbiItem('event OnRamped(uint256 amount, uint256 principal, address indexed custody, bytes32 indexed wireRef)');
const BookMarked = parseAbiItem('event NavReported(uint256 previous, uint256 current, bytes32 indexed reportHash, uint256 totalAssets)');
const Subscribed = parseAbiItem('event Subscribed(uint256 assets, uint256 shares)');
const Approved = parseAbiItem('event Approved(address indexed account, uint8 tier, uint64 expiresAt, bytes32 dossierHash, bytes letter)');
const Rejected = parseAbiItem('event Rejected(address indexed account, bytes32 dossierHash, bytes letter)');
const EpochPart = parseAbiItem('event EpochPart(uint256 indexed epoch, uint256 indexed part, bytes distribution)');
const ReportPublished = parseAbiItem(
  'event ReportPublished(uint256 indexed index, uint256 indexed epoch, bytes32 indexed kind, bytes blob, bytes32 ciphertextCommitment, bytes32 plaintextCommitment)',
);

async function logsInChunks<T>(fetch: (from: bigint, to: bigint) => Promise<T[]>, from: bigint, head: bigint, chunk: bigint) {
  const ranges: [bigint, bigint][] = [];
  for (let start = from; start <= head; start += chunk) ranges.push([start, start + chunk - 1n > head ? head : start + chunk - 1n]);
  const out: T[] = [];
  // Four at a time: QoreChain's endpoint is behind Cloudflare, which answers bursts with 1015.
  for (let i = 0; i < ranges.length; i += 4) {
    const batch = await Promise.all(ranges.slice(i, i + 4).map(([f, t]) => fetch(f, t)));
    for (const logs of batch) out.push(...logs);
  }
  return out;
}

const QORE_LOG_RANGE = 10_000n;
const scanned = new Map<string, { to: bigint; logs: any[] }>();
const OVERLAP = 32n;

/// Reads only the blocks since the last read of the same query, for the life of the tab.
async function logsSince<T extends { transactionHash: Hex | null; logIndex: number | null }>(
  key: string,
  fetch: (from: bigint, to: bigint) => Promise<T[]>,
  from: bigint,
  head: bigint,
  chunk: bigint,
): Promise<T[]> {
  const seen = scanned.get(key);
  const start = seen ? (seen.to - OVERLAP > from ? seen.to - OVERLAP : from) : from;
  if (seen && start > head) return seen.logs;
  const fresh = await logsInChunks(fetch, start, head, chunk);
  const ids = new Set((seen?.logs ?? []).map((l: T) => `${l.transactionHash}:${l.logIndex}`));
  const logs = [...(seen?.logs ?? []), ...fresh.filter((l) => !ids.has(`${l.transactionHash}:${l.logIndex}`))];
  scanned.set(key, { to: head, logs });
  return logs;
}

export type Event = {
  chain: 'qorechain' | 'ethereum';
  kind: string;
  amount: bigint;
  block: bigint;
  tx: Hex;
  ts?: number;
  detail?: string;
};

/// The route as it ran: every crossing, subscription, wire, mark and collection, both chains, newest first.
export function useActivity() {
  return useQuery({
    queryKey: ['activity'],
    refetchInterval: 30_000,
    queryFn: async (): Promise<{ events: Event[]; navs: { ts: number; price: bigint; block: bigint }[] }> => {
      const qHead = await qore.getBlockNumber();
      const eHead = await l1.getBlockNumber().catch(() => null);
      const qLogs = (event: any, address: Address) =>
        logsSince(`q:${address}:${event.name}`, (f, t) => qore.getLogs({ address, event, fromBlock: f, toBlock: t }) as any, QORECHAIN.deployedAtBlock, qHead, QORE_LOG_RANGE);
      const eLogs = (event: any, address: Address) =>
        eHead === null
          ? Promise.resolve([] as any[])
          : logsSince(`e:${address}:${event.name}`, (f, t) => l1.getLogs({ address, event, fromBlock: f, toBlock: t }) as any, ETHEREUM.deployedAtBlock, eHead!, 5_000n);
      const orNone = (p: Promise<any[]>) => p.catch(() => [] as any[]);
      const [navs, allocs, returns, subs, offs, ons, marks] = await Promise.all([
        orNone(qLogs(NavReported, QORECHAIN.vault)),
        orNone(qLogs(Allocated, QORECHAIN.allocator)),
        orNone(qLogs(ReturnSettled, QORECHAIN.allocator)),
        orNone(eLogs(Subscribed, ETHEREUM.receiver)),
        orNone(eLogs(OffRamped, ETHEREUM.issuer)),
        orNone(eLogs(OnRamped, ETHEREUM.issuer)),
        orNone(eLogs(BookMarked, ETHEREUM.issuer)),
      ]);

      // Times from one block header per chain: QoreChain makes a block about every 1.3 s, Sepolia every 12 s.
      const [qRef, eRef] = await Promise.all([
        qore.getBlock({ blockNumber: qHead }),
        eHead === null ? null : l1.getBlock({ blockNumber: eHead }).catch(() => null),
      ]);
      const timeOf = (ref: { number: bigint | null; timestamp: bigint }, secs: number) => (n: bigint) =>
        Number(ref.timestamp) - Number((ref.number ?? 0n) - n) * secs;
      const qAt = timeOf(qRef, 1.3);
      const eAt = eRef ? timeOf(eRef, 12) : () => undefined;

      const row = (chain: Event['chain'], kind: string, l: any, amount: bigint, detail?: string): Event => ({
        chain,
        kind,
        amount,
        block: l.blockNumber,
        tx: l.transactionHash,
        ts: chain === 'qorechain' ? qAt(l.blockNumber) : eAt(l.blockNumber),
        detail,
      });

      const events: Event[] = [
        ...allocs.map((l: any) => row('qorechain', 'Allocated to Ethereum', l, l.args.amount)),
        ...returns.map((l: any) => row('qorechain', 'Returned, ML-DSA attested', l, l.args.amount)),
        ...navs.map((l: any) => row('qorechain', 'Vault marked, ML-DSA signed', l, l.args.current, `price ${(Number(l.args.sharePrice) / 1e6).toFixed(6)}`)),
        ...subs.map((l: any) => row('ethereum', 'Subscribed to the issuer', l, l.args.assets)),
        ...offs.map((l: any) => row('ethereum', 'Wired to custody', l, l.args.amount)),
        ...ons.map((l: any) => row('ethereum', 'Collections on-ramped', l, l.args.amount)),
        ...marks.map((l: any) => row('ethereum', 'Book marked', l, l.args.current, `tape ${String(l.args.reportHash).slice(0, 10)}…`)),
      ].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

      return { events, navs: navs.map((l: any) => ({ ts: qAt(l.blockNumber), price: l.args.sharePrice, block: l.blockNumber })) };
    },
  });
}

export type Request = { id: bigint; assets: bigint; requestedAt: bigint; settled: boolean };

/// This lender's queued exits, from the vault's own index (a cross-VM call leaves no log the chain serves).
export function useRequests() {
  const { account } = useWallet();
  return useQuery({
    queryKey: ['requests', account?.evm],
    enabled: !!account,
    refetchInterval: REFRESH,
    queryFn: async (): Promise<Request[]> => {
      const ids = await read<readonly bigint[]>(QORECHAIN.vault, AgUSDAbi, 'requestsOf', [account!.evm]);
      const next = await read<bigint>(QORECHAIN.vault, AgUSDAbi, 'nextToSettle');
      const rows = await Promise.all(
        ids.map(async (id) => {
          const r = await read<readonly [Address, Address, bigint, bigint]>(QORECHAIN.vault, AgUSDAbi, 'redemptions', [id]);
          return { id, assets: r[3], requestedAt: r[2], settled: id < next };
        }),
      );
      return rows.reverse();
    },
  });
}

/// The compliance decision on this lender, with the sealed letter that explains it (opened by the caller).
export function useDecision(member?: Member) {
  const { account } = useWallet();
  const decided = member && (member.status === 'Approved' || member.status === 'Rejected') && member.decidedBlock > 0n;
  return useQuery({
    queryKey: ['decision', account?.evm, String(member?.decidedBlock ?? 0n)],
    enabled: !!account && !!decided,
    staleTime: Infinity,
    queryFn: async (): Promise<{ letter: Hex; tx: Hex } | null> => {
      const b = member!.decidedBlock;
      const event = member!.status === 'Approved' ? Approved : Rejected;
      const logs = await qore.getLogs({ address: QORECHAIN.access, event: event as any, args: { account: account!.evm } as any, fromBlock: b, toBlock: b });
      const l = logs.at(-1) as any;
      return l ? { letter: l.args.letter as Hex, tx: l.transactionHash as Hex } : null;
    },
  });
}

export type RoomReport = {
  index: bigint;
  epoch: bigint;
  publishedAt: bigint;
  size: number;
  ciphertextCommitment: Hex;
  plaintextCommitment: Hex;
  blob?: Hex;
  tx?: Hex;
};

/// The data room as the chain holds it: epochs, who is in them, and the sealed reports.
export function useDataRoom() {
  const { account } = useWallet();
  return useQuery({
    queryKey: ['dataroom', account?.evm],
    refetchInterval: 30_000,
    queryFn: async () => {
      const [epochCount, reportCount] = await Promise.all([
        read<bigint>(QORECHAIN.dataRoom, DataRoomAbi, 'epochCount'),
        read<bigint>(QORECHAIN.dataRoom, DataRoomAbi, 'reportCount'),
      ]);
      const latest = await read<readonly any[]>(QORECHAIN.dataRoom, DataRoomAbi, 'latestReports', [6n]);
      const reports: RoomReport[] = await Promise.all(
        latest.map(async (r: any, i: number) => {
          const index = reportCount - 1n - BigInt(i);
          const logs = await qore
            .getLogs({ address: QORECHAIN.dataRoom, event: ReportPublished, args: { index }, fromBlock: r.blockNumber, toBlock: r.blockNumber })
            .catch(() => []);
          const l = logs.at(-1) as any;
          return {
            index,
            epoch: r.epoch,
            publishedAt: r.publishedAt,
            size: r.size,
            ciphertextCommitment: r.ciphertextCommitment,
            plaintextCommitment: r.plaintextCommitment,
            blob: l?.args.blob as Hex | undefined,
            tx: l?.transactionHash as Hex | undefined,
          };
        }),
      );
      // The epoch key comes in parts of eight readers; this lender reads only its own part.
      let current: { epoch: bigint; members: number; parts: number; distribution?: Hex; isMember: boolean } | null = null;
      if (epochCount > 0n) {
        const e = epochCount - 1n;
        const ep = await read<any>(QORECHAIN.dataRoom, DataRoomAbi, 'epochs', [e]);
        let distribution: Hex | undefined;
        let isMember = false;
        if (account) {
          const [member, part, at] = await read<readonly [boolean, bigint, bigint]>(QORECHAIN.dataRoom, DataRoomAbi, 'partOf', [e, account.evm]);
          isMember = member;
          if (member && at > 0n) {
            const logs = await qore
              .getLogs({ address: QORECHAIN.dataRoom, event: EpochPart, args: { epoch: e, part }, fromBlock: at, toBlock: at })
              .catch(() => []);
            distribution = (logs.at(-1) as any)?.args.distribution;
          }
        }
        current = { epoch: e, members: ep.members, parts: ep.parts, distribution, isMember };
      }
      return { epochCount, reportCount, reports, current };
    },
  });
}

/// An envelope's size in kB, for the copy.
export const kb = (hex?: Hex) => (hex ? `${((hex.length - 2) / 2 / 1024).toFixed(1)} kB` : '');

// ---------------------------------------------------------------------------
// Writes, all through QoreX
// ---------------------------------------------------------------------------

/// A wallet error, trimmed to the sentence a person can act on.
export function reason(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; name?: string };
  if (/rejected|denied|cancel/i.test(err?.message ?? '')) return 'You declined it in QoreX.';
  return err?.shortMessage ?? err?.message ?? 'The transaction failed.';
}

export function useActions() {
  const qc = useQueryClient();
  const toast = useToasts();
  const { account } = useWallet();

  async function send(title: string, done: string, msgs: EncodedMsg[], gas: number) {
    if (!account) throw new Error('Connect QoreX first.');
    const id = toast.start(title);
    try {
      const res = await signAndBroadcast(msgs, `agama: ${title.toLowerCase()}`, gas);
      toast.hash(id, res.txHash);
      toast.done(id, res.shield === 'shielded' ? `${done} Shielded: ML-DSA-87 layer confirmed in the block.` : done);
      // The next block carries the new state; refetch a moment later too, for a node that is a block behind.
      await qc.invalidateQueries();
      setTimeout(() => void qc.invalidateQueries(), 2_500);
      return res.txHash;
    } catch (e) {
      toast.fail(id, reason(e));
      throw new Error(reason(e));
    }
  }
  const call = (target: Address, abi: any, functionName: string, args: unknown[] = []) =>
    crossVmCall(account!.address, target, encodeFunctionData({ abi, functionName, args }));

  return {
    /// The fest's fUSD into the route's dollar, one signature: convert what is still in bank form, approve, swap.
    rampFusd: (amount: bigint, bankPart: bigint) => {
      const msgs: EncodedMsg[] = [];
      if (bankPart > 0n) msgs.push(convertCoin(account!.address, account!.evm, `erc20:${QORECHAIN.fusd}`, bankPart));
      msgs.push(call(QORECHAIN.fusd, MockUSDCAbi, 'approve', [QORECHAIN.fusdOnRamp, amount]));
      msgs.push(call(QORECHAIN.fusdOnRamp, FestUsdOnRampAbi, 'onRamp', [amount]));
      return send(`Swap ${fmt(amount)} fUSD`, `${fmt(amount)} USDC from your fest fUSD.`, msgs, 1_200_000 + 300_000 * (msgs.length - 2));
    },
    faucet: () =>
      send('Mock USDC from the faucet', '10,000 mock USDC is in your wallet.', [call(QORECHAIN.usdc, MockUSDCAbi, 'faucet')], 600_000),
    /// One transaction, one ML-DSA-87 signature: the approval only when it is missing, then the deposit.
    deposit: async (amount: bigint, allowance: bigint) => {
      const msgs: EncodedMsg[] = [];
      if (allowance < amount) msgs.push(call(QORECHAIN.usdc, MockUSDCAbi, 'approve', [QORECHAIN.vault, maxUint256]));
      msgs.push(call(QORECHAIN.vault, AgUSDAbi, 'deposit', [amount, account!.evm]));
      return send(`Deposit ${fmt(amount)} USDC`, 'agUSD minted. It is earning from this block.', msgs, 700_000 + 300_000 * (msgs.length - 1));
    },
    redeem: (shares: bigint) =>
      send(`Withdraw ${fmt(shares)} agUSD`, 'USDC is in your wallet.', [call(QORECHAIN.vault, AgUSDAbi, 'redeem', [shares, account!.evm, account!.evm])], 700_000),
    requestRedeem: (shares: bigint) =>
      send(`Queue ${fmt(shares)} agUSD`, 'Priced now, paid as cash comes home. See Portfolio.', [
        call(QORECHAIN.vault, AgUSDAbi, 'requestRedeem', [shares, account!.evm, account!.evm]),
      ], 900_000),
    settle: () =>
      send('Push the queue', 'Paid what the cash covers.', [call(QORECHAIN.vault, AgUSDAbi, 'settleRedemptions', [16n])], 900_000),
    /// Publishes the lender's ML-KEM-1024 key twice in one transaction: in QoreChain's KEM registry, where any
    /// QoreSeal client finds it, and in the AccessRegistry, which the compliance officer seals the letter to.
    publishKey: async (mlkemPublicKey: Uint8Array) => {
      // QoreChain refuses to publish the same KEM key twice (pqc 253): the registry message goes only when needed.
      const cur = await fetch(`${REST}/qorechain/pqc/v1/kem/${account!.address}`).then((r) => r.json()).catch(() => ({}));
      const same = cur?.found && cur.key?.public_key === btoa(String.fromCharCode(...mlkemPublicKey));
      return send('Publish your encryption key', 'Your ML-KEM-1024 key is on chain.', [
        ...(same ? [] : [registerKemKey(account!.address, mlkemPublicKey)]),
        call(QORECHAIN.access, AccessRegistryAbi, 'publishEncryptionKey', [toHex(mlkemPublicKey)]),
      ], 2_500_000);
    },
    fileDossier: (envelope: Hex) =>
      send('File your sealed application', 'Filed. Compliance reviews it within a minute.', [
        call(QORECHAIN.access, AccessRegistryAbi, 'fileDossier', [envelope]),
      ], 4_800_000),
  };
}

/// The officers as QoreSeal recipients. Each one's ML-KEM-1024 key comes from QoreChain's KEM registry, its ML-DSA-87
/// key from the PQC registry, and its X25519 key from a recipient card it signed with QoreSign; the card is verified
/// here against both on-chain keys before a single byte is sealed to it. A card that fails falls back to ML-KEM-1024
/// alone, and says so.
export function useOfficerKeys() {
  return useQuery({
    queryKey: ['officers'],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const get = async (role: 'compliance' | 'auditor') => {
        const card = (cards as Record<string, RecipientCard>)[role];
        const [kem, pq] = await Promise.all([
          fetch(`${REST}/qorechain/pqc/v1/kem/${card.address}`).then((r) => r.json()),
          fetch(`${REST}/qorechain/pqc/v1/account/${card.address}`).then((r) => r.json()),
        ]);
        if (!kem.found) throw new Error(`The ${role} officer has no encryption key on chain`);
        const mlkemPublicKey = b64(kem.key.public_key);
        try {
          const r = verifyRecipientCard({ card, chainId: COSMOS_CHAIN_ID, pqPublicKey: b64(pq.account.public_key), mlkemPublicKey });
          return { recipient: r, hybrid: true };
        } catch {
          return { recipient: { mlkemPublicKey } as SealRecipient, hybrid: false };
        }
      };
      const [compliance, auditor] = await Promise.all([get('compliance'), get('auditor')]);
      return { compliance, auditor, hybrid: compliance.hybrid && auditor.hybrid };
    },
  });
}
