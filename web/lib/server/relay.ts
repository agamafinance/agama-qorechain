/**
 * Agama's relayer, inside the app: the same path as keeper/src/pqaccounts.ts, for the deployment. The lender signs a
 * plain-text message in QoreX; this route submits it to PqAccountFactory.execute as a hybrid-signed (secp256k1 +
 * ML-DSA-87) native transaction (lib/server/native.ts) and pays the gas. The relayer has no EVM window: it can only
 * act through post-quantum transactions. The keeper keeps it funded (keeper/src/cli.ts tick).
 *
 * Nothing here decides whether a message is genuine: the lender's PqAccount checks the ML-DSA-87 signature on chain
 * with pqcVerify. The simulation runs that same check, so a message the chain would refuse is refused here before
 * the relayer spends anything.
 */
import { parseAbi, type Address, type Hex } from 'viem';
import { qore } from '../chains';
import { QORECHAIN } from '../deployments';
import { writeNative } from './native';

export { relayerConfigured } from './native';

const factoryAbi = parseAbi([
  'function execute(address owner, (address target, bytes data)[] calls, string summary, uint256 deadline, bytes pqSignature)',
  'function accountOf(address owner) view returns (address)',
  'function nonce() view returns (uint256)',
]);
const ALLOWED = new Set([QORECHAIN.usdc, QORECHAIN.access, QORECHAIN.vault].map((a) => a.toLowerCase()));


type Req = {
  owner: Address;
  calls: { target: Address; data: Hex }[];
  summary: string;
  deadline: string;
  signature: { pq?: { signature?: string } };
};

export async function submit(req: Req) {
  const { owner, calls, summary } = req ?? ({} as Req);
  if (typeof req?.deadline !== 'string' || !/^\d{1,12}$/.test(req.deadline)) throw new Error('bad deadline');
  const deadline = BigInt(req.deadline);
  if (typeof owner !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new Error('bad owner');
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > 4) throw new Error('one to four calls');
  if (calls.some((c) => !ALLOWED.has(String(c?.target).toLowerCase()) || typeof c.data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(c.data)))
    throw new Error("only Agama's contracts");
  if (typeof summary !== 'string' || summary.length > 200) throw new Error('bad summary');
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= now || deadline > now + 900n) throw new Error('the message expired, or expires more than 15 minutes ahead');
  const pq = req.signature?.pq?.signature;
  if (typeof pq !== 'string' || pq.length > 20_000) throw new Error('the message carries no ML-DSA-87 signature');

  const pqSignature = `0x${Buffer.from(pq, 'base64').toString('hex')}` as Hex;
  const acc = (await qore.readContract({ address: QORECHAIN.pqAccountFactory, abi: factoryAbi, functionName: 'accountOf', args: [owner] })) as Address;
  const code = await qore.getCode({ address: acc });
  const nonce = code && code !== '0x' ? ((await qore.readContract({ address: acc, abi: factoryAbi, functionName: 'nonce' })) as bigint) : 0n;
  const { hash, gasUsed } = await writeNative(QORECHAIN.pqAccountFactory, factoryAbi, 'execute', [owner, calls, summary, deadline, pqSignature], `agama execute ${acc.toLowerCase()} ${nonce}`);
  console.log(`pq ${summary} for owner ${owner}: ${hash} (native, hybrid) gas ${gasUsed}`);
  return { txHash: hash, gasUsed };
}

/** The reason a refusal shows the lender: the contract's, not viem's whole report. */
export function refusal(e: unknown) {
  const m = String((e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? e);
  return m.split('\n')[0].slice(0, 300);
}
