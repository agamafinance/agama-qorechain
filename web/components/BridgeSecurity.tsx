'use client';

// The bridge, as the chains say it is right now: what attests money going to Ethereum (read from the hybrid
// messenger on Sepolia) and money coming home (ML-DSA-87, checked by QoreChain's pqcVerify).
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { parseAbi, type Address } from 'viem';
import { ethAddress, l1 } from '@/lib/chains';
import { ETHEREUM } from '@/lib/deployments';
import { card } from './ui';

const abi = parseAbi([
  'function pqVerifier() view returns (address)',
  'function ecdsaAttester() view returns (address)',
  'function scheme() view returns (string)',
]);

export function BridgeSecurity() {
  const { data } = useQuery({
    queryKey: ['bridge-security'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const verifier = (await l1.readContract({ address: ETHEREUM.messenger, abi, functionName: 'pqVerifier' })) as Address;
      const scheme = await l1.readContract({ address: verifier, abi, functionName: 'scheme' });
      return { verifier, scheme };
    },
  });
  const rows: [string, string, string, string | undefined][] = [
    ['QoreChain → Ethereum', 'secp256k1 + ' + (data?.scheme ?? 'post-quantum proof'), 'both checked on Ethereum; no owner, rotation only by both', data ? ethAddress(data.verifier) : undefined],
    ['Ethereum → QoreChain', 'ML-DSA-87 (FIPS 204, level 5)', "checked by QoreChain's pqcVerify precompile", undefined],
  ];
  return (
    <div className={`${card} !p-4 md:!p-5`}>
      <div className="flex items-center gap-2 text-[13px] uppercase tracking-wider text-fg-muted">
        <ShieldCheck className="h-4 w-4 text-[#2f7d5b]" aria-hidden /> The bridge is quantum resilient both ways
      </div>
      <div className="mt-3 divide-y divide-[#254839]/10 text-[13px]">
        {rows.map(([dir, what, how, link]) => (
          <div key={dir} className="grid gap-1 py-2 md:grid-cols-[190px_1fr_1fr] md:gap-4">
            <div className="font-medium text-fg">{dir}</div>
            <div className="text-fg">
              {link ? (
                <a href={link} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                  {what}
                </a>
              ) : (
                what
              )}
            </div>
            <div className="text-fg-muted">{how}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
