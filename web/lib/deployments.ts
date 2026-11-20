// The live addresses, read from the deployment records the keeper writes (deployments/*.json at the repo root), so
// the app and the keeper can never disagree about where the contracts are.
import type { Address } from 'viem';
import q from '../../deployments/qorechain-diana.json';
import e from '../../deployments/ethereum-sepolia.json';

export const QORECHAIN = {
  chainId: 9800,
  deployedAtBlock: BigInt(q.deployedAtBlock),
  usdc: q.usdc as Address,
  access: q.access as Address,
  vault: q.vault as Address,
  pqAccountFactory: q.pqAccountFactory as Address,
  messenger: q.messenger as Address,
  allocator: q.allocator as Address,
  dataRoom: q.dataRoom as Address,
  hybridGuard: q.hybridGuard as Address,
  complianceModule: q.complianceModule as Address,
  fusd: q.fusd as Address,
  fusdOnRamp: q.fusdOnRamp as Address,
  roles: q.roles as Record<'operator' | 'admin' | 'reporter' | 'compliance' | 'attester' | 'guardian' | 'auditor', Address>,
};

export const ETHEREUM = {
  chainId: 11155111,
  deployedAtBlock: BigInt(e.deployedAtBlock),
  usdc: e.usdc as Address,
  messenger: e.messenger as Address,
  issuer: e.issuer as Address,
  receiver: e.receiver as Address,
  /** The allocator's cumulative counters when the route moved to the hybrid (post-quantum) Ethereum leg. */
  sentBase: BigInt((e as any).pq?.allocatorSentAtMigration ?? 0),
  returnedBase: BigInt((e as any).pq?.allocatorReturnedAtMigration ?? 0),
  pq: (e as any).pq as undefined | { mldsa44Verifier: Address; wotsVerifier: Address; lattice: Address; activeScheme: string },
};
