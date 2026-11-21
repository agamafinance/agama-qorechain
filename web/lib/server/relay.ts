/**
 * Agama's relayer, inside the app: the same path as keeper/src/pqaccounts.ts, for the deployment. The lender signs a
 * plain-text message in QoreX; this route submits it to PqAccountFactory.execute and pays the gas. It holds one
 * secret, RELAYER_PRIVATE_KEY: the relayer's coin-60 key, which only ever pays gas and can only call the factory (its
 * EVM window is scoped to it). The keeper keeps that window open and the relayer funded (keeper/src/cli.ts tick).
 *
 * Nothing here decides whether a message is genuine: the lender's PqAccount checks the ML-DSA-87 signature on chain
 * with pqcVerify. The gas estimate runs that same check, so a message the chain would refuse is refused here before
 * the relayer spends anything.
 */
import { createWalletClient, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { diana, EVM_RPC, qore } from '../chains';
import { QORECHAIN } from '../deployments';
import { nativeHash } from './explorer';

const factoryAbi = parseAbi([
  'function execute(address owner, (address target, bytes data)[] calls, string summary, uint256 deadline, bytes pqSignature)',
]);
const ALLOWED = new Set([QORECHAIN.usdc, QORECHAIN.access, QORECHAIN.vault].map((a) => a.toLowerCase()));

export const relayerConfigured = () => /^0x[0-9a-fA-F]{64}$/.test(process.env.RELAYER_PRIVATE_KEY?.trim() ?? '');

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

  const account = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY!.trim() as Hex);
  const wallet = createWalletClient({ account, chain: diana, transport: http(EVM_RPC, { retryCount: 2, retryDelay: 1_500 }) });
  const pqSignature = `0x${Buffer.from(pq, 'base64').toString('hex')}` as Hex;
  const args = [owner, calls, summary, deadline, pqSignature] as const;
  // The estimate executes the account's pqcVerify: a bad signature, a stale nonce or a refused call stops here.
  const gas = await qore.estimateContractGas({ address: QORECHAIN.pqAccountFactory, abi: factoryAbi, functionName: 'execute', args, account });
  let hash: Hex;
  try {
    hash = await wallet.writeContract({ address: QORECHAIN.pqAccountFactory, abi: factoryAbi, functionName: 'execute', args, gas: (gas * 125n) / 100n });
  } catch (e) {
    // Two lenders at the same instant can race for the relayer's nonce: the second asks again once.
    if (!/nonce|already known|replacement/i.test(String((e as Error)?.message))) throw e;
    await new Promise((r) => setTimeout(r, 2_500));
    hash = await wallet.writeContract({ address: QORECHAIN.pqAccountFactory, abi: factoryAbi, functionName: 'execute', args, gas: (gas * 125n) / 100n });
  }
  const receipt = await qore.waitForTransactionReceipt({ hash, timeout: 50_000 });
  if (receipt.status !== 'success') throw new Error(`reverted on chain in ${hash}`);
  console.log(`pq ${summary} for owner ${owner}: ${hash} gas ${receipt.gasUsed}`);
  // The explorer link in the lender's toast: the native QoreChain hash that carries this EVM transaction.
  return { txHash: (await nativeHash(hash)) ?? hash, evmHash: hash, gasUsed: String(receipt.gasUsed) };
}

/** The reason a refusal shows the lender: the contract's, not viem's whole report. */
export function refusal(e: unknown) {
  const m = String((e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? e);
  // What QoreChain answers an EVM call from an account whose EVM window has lapsed; the keeper reopens it.
  if (/Missing or invalid parameters/i.test(m)) return "Agama's relayer is reopening its EVM window. Try again in a minute.";
  return m.split('\n')[0].slice(0, 300);
}
