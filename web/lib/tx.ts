'use client';

/**
 * One transaction as Agama sees it: the native QoreChain record, the EVM transaction it carries when there is one,
 * the post-quantum evidence the chain recorded, and the Agama action decoded from the calldata. The public explorer
 * opens on mainnet (a cookie it sets when you switch), so the app shows its testnet transactions itself.
 */
import { useQuery } from '@tanstack/react-query';
import { decodeEventLog, decodeFunctionData, hexToBytes, parseAbi, parseAbiItem, type Abi, type Hex } from 'viem';
import { AccessRegistryAbi, AgUSDAbi, CrossChainAllocatorAbi, DataRoomAbi, MockUSDCAbi, PqAttestedMessengerAbi } from '@abi';
import { qore, REST } from './chains';
import { QORECHAIN } from './deployments';
import { toBech32 } from './bech32';

export type TxView = {
  cosmosHash: string;
  evmHash?: string;
  height: number;
  time: string;
  ok: boolean;
  gasUsed: number;
  feeQor: number;
  messages: string[];
  /** secp256k1 + ML-DSA-87 on the native lane, as the chain's ante handler checked it. */
  hybridVerified: boolean;
  /** Who sent it, as a qor1 address. */
  sender?: string;
  /** An EVM transaction admitted by its sender's post-quantum EVM window. */
  evmWindow?: { address: string; usedTxs: string };
  /** A lender's action: the message it signed in QoreX, checked on chain by its PqAccount with pqcVerify. */
  lender?: { owner: string; account: string; summary: string; nonce?: number; calls: string[]; sigBytes: number };
  /** What a keeper transaction did, when it called one of Agama's contracts. */
  action?: string;
  log?: string;
};

const factoryAbi = parseAbi(['function execute(address owner, (address target, bytes data)[] calls, string summary, uint256 deadline, bytes pqSignature)']);
const executed = parseAbiItem('event Executed(uint256 indexed nonce, bytes32 indexed callsHash, address indexed submitter, uint256 calls)');
const attr = (e: { attributes: { key: string; value: string }[] }, k: string) => e.attributes.find((a) => a.key === k)?.value;
const qor = (a: string) => toBech32('qor', hexToBytes(a as Hex));

const CONTRACTS: [string, string, Abi][] = [
  [QORECHAIN.usdc, 'USDC', MockUSDCAbi as Abi],
  [QORECHAIN.vault, 'agUSD vault', AgUSDAbi as Abi],
  [QORECHAIN.access, 'Access registry', AccessRegistryAbi as Abi],
  [QORECHAIN.dataRoom, 'Data room', DataRoomAbi as Abi],
  [QORECHAIN.allocator, 'Allocator', CrossChainAllocatorAbi as Abi],
  [QORECHAIN.messenger, 'Messenger', PqAttestedMessengerAbi as Abi],
];

/** What a call to one of Agama's contracts does, in a few words. */
const PLAIN: Record<string, string> = {
  faucet: 'Mint 10,000 test USDC',
  approve: 'Approve USDC for the vault',
  deposit: 'Deposit USDC into the agUSD vault',
  redeem: 'Withdraw from the agUSD vault',
  requestRedeem: 'Queue an agUSD withdrawal',
  publishEncryptionKey: 'Publish an ML-KEM-1024 encryption key',
  fileDossier: 'File a sealed (ML-KEM-1024) application',
  settleRedemptions: 'Pay queued agUSD withdrawals',
  reject: 'Compliance decision (rejected), signed with ML-DSA-87',
  revoke: 'Compliance revocation, signed with ML-DSA-87',
  allocate: 'Send vault cash to the book on Ethereum (CCTP V2, ML-DSA attested)',
  settleReturn: 'Cash back from Ethereum (ML-DSA attested)',
  reportNav: 'Mark agUSD to the book, signed with ML-DSA-87',
  publishEpoch: 'Data room: new epoch key, sealed with ML-KEM-1024',
  publishEpochPart: 'Data room: epoch key part, sealed with ML-KEM-1024',
  publishReport: 'Data room: sealed loan tape, signed with ML-DSA-87',
};

function describe(target: string, data: Hex): string {
  const c = CONTRACTS.find(([a]) => a.toLowerCase() === target.toLowerCase());
  if (!c) return `Call to ${target.slice(0, 10)}…`;
  try {
    const { functionName } = decodeFunctionData({ abi: c[2], data });
    if (c[0] === QORECHAIN.access && functionName === 'approve') return 'Compliance decision (approved), signed with ML-DSA-87';
    return PLAIN[functionName] ?? `${c[1]}: ${functionName}`;
  } catch {
    return `${c[1]} call`;
  }
}

async function nativeHash(input: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input)) return input.toUpperCase();
  const base = REST.replace(/\/api\/rest$/, '');
  const r = await fetch(`${base}/api/tx/${input}`);
  const j = (await r.json()) as { cosmosHash?: string; error?: string };
  if (!j.cosmosHash) throw new Error(j.error ?? 'Transaction not found on qorechain-diana');
  return j.cosmosHash;
}

async function readTx(input: string): Promise<TxView> {
  const cosmosHash = await nativeHash(input);
  const r = await fetch(`${REST}/cosmos/tx/v1beta1/txs/${cosmosHash}`);
  if (!r.ok) throw new Error('Transaction not found on qorechain-diana');
  const { tx, tx_response: t } = await r.json();
  const events: { type: string; attributes: { key: string; value: string }[] }[] = t.events ?? [];
  const evmHash = events.map((e) => (e.type === 'ethereum_tx' ? attr(e, 'ethereumTxHash') : undefined)).find(Boolean);
  const win = events.find((e) => e.type === 'pqc_evm_window_used');
  const view: TxView = {
    cosmosHash,
    evmHash,
    height: Number(t.height),
    time: t.timestamp,
    ok: t.code === 0,
    gasUsed: Number(t.gas_used),
    feeQor: Number(tx.auth_info?.fee?.amount?.find((a: { denom: string }) => a.denom === 'uqor')?.amount ?? 0) / 1e6,
    messages: tx.body.messages.map((m: { '@type': string }) => m['@type'].split('.').at(-1)),
    hybridVerified: events.some((e) => e.type === 'pqc_hybrid_verify' && attr(e, 'status') === 'verified'),
    sender: events.find((e) => e.type === 'message')?.attributes.find((a) => a.key === 'sender')?.value,
    evmWindow: win ? { address: attr(win, 'address') ?? '', usedTxs: attr(win, 'used_txs') ?? '' } : undefined,
    log: t.code === 0 ? undefined : t.raw_log,
  };

  if (evmHash) {
    const [etx, receipt] = await Promise.all([
      qore.getTransaction({ hash: evmHash as Hex }).catch(() => null),
      qore.getTransactionReceipt({ hash: evmHash as Hex }).catch(() => null),
    ]);
    if (etx?.from) view.sender = qor(etx.from);
    if (receipt && !view.feeQor) view.feeQor = Number(receipt.gasUsed * receipt.effectiveGasPrice) / 1e18;
    if (etx?.to && etx.to.toLowerCase() === QORECHAIN.pqAccountFactory.toLowerCase()) {
      const { args } = decodeFunctionData({ abi: factoryAbi, data: etx.input });
      const [owner, calls, summary, , sig] = args;
      const log = receipt?.logs.find((l) => {
        try {
          return decodeEventLog({ abi: [executed], data: l.data, topics: l.topics }).eventName === 'Executed';
        } catch {
          return false;
        }
      });
      const nonce = log ? Number(decodeEventLog({ abi: [executed], data: log.data, topics: log.topics }).args.nonce) : undefined;
      view.lender = {
        owner: qor(owner),
        account: log?.address ?? '',
        summary: summary.replace(/^Agama: /, ''),
        nonce,
        calls: calls.map((c) => describe(c.target, c.data)),
        sigBytes: (sig.length - 2) / 2,
      };
    } else if (etx?.to) {
      view.action = describe(etx.to, etx.input);
    }
  }
  return view;
}

export function useTx(hash: string) {
  return useQuery({ queryKey: ['tx', hash], enabled: !!hash, queryFn: () => readTx(hash), retry: 2, retryDelay: 2_000, staleTime: Infinity });
}
