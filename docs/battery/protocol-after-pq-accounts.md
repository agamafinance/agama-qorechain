# Protocol battery after the PqAccount change, 2026-11-20T18:06Z

`BATTERY_BASE=30 tsx keeper/src/battery.ts`, qorechain-diana and Sepolia.

    PASS  treasury sends 50 fest fUSD (bank form) to two lenders  (B29724E61B1BCCFB8F6DC4D3B125182125806674EEC8DCA135CB596B13093CF1)
    PASS  8 lenders registered ML-DSA-87 keys and published ML-KEM-1024 keys in parallel  (8/8)
    PASS  8 sealed dossiers on chain, none readable in clear  (3552, 3552, 3551, 3554, 3559, 3558, 3538, 3549 bytes)
    PASS  the keeper decided all 8 dossiers  (in 41s after filing)
    PASS  Aurelia Capital SAS: Approved, letter opened by its own key  (Eligible as professional investor for 180 days.)
    PASS  Brandt Pension Fund: Approved, letter opened by its own key  (Eligible as institutional investor for 180 days.)
    PASS  Clara Meier: Approved, letter opened by its own key  (Eligible as accredited individual investor for 180 days.)
    PASS  Delta Family Office Pte: Approved, letter opened by its own key  (Eligible as professional investor for 180 days.)
    PASS  Emirates Credit Partners: Approved, letter opened by its own key  (Eligible as institutional investor for 180 days.)
    PASS  Fennel Asset Management BV: Approved, letter opened by its own key  (Eligible as professional investor for 180 days.)
    PASS  Gaston Petit: Rejected, letter opened by its own key  (The note is reserved to professional, institutional and accredited investors.)
    PASS  Harbor Ridge LLC: Rejected, letter opened by its own key  (The note cannot be offered to residents of US.)
    PASS  one lender cannot open another's dossier
    PASS  the auditor's view key opens all 8 dossiers
    PASS  a refused lender's deposit fails on chain, atomically  (the faucet mint in the same transaction rolled back too)
    PASS  a key that is not ML-KEM-1024 is refused
    PASS  a dossier that is not a QoreSeal envelope is refused
    PASS  six concurrent deposits all minted agUSD  (985 / 2463 / 4926 / 7390 / 11824 / 19707)
    PASS  each lender got agUSD worth what it paid, to 0.1%  (price 1.014818)
    PASS  vault assets grew by the deposits  ($48,000 in)
    PASS  50 fest fUSD from the bank into the vault's dollar, one transaction
    PASS  agUSD moves between two approved lenders
    PASS  agUSD cannot be sent to a refused account
    PASS  the keeper sent the new money to Ethereum and every burn was minted there  ($43,195.19 in 215s)
    PASS  the vault kept its 10% buffer  ($20,042.48 of $200,224.85)
    PASS  the issuer wired up to its 90% cap to the book  (book $162,185, cash $18,020.56)
    PASS  all six approved lenders decrypt tape #18 of epoch 14  (54 members in 7 parts, 14.4 kB each at most)
    PASS  neither refused lender can open the epoch key
    PASS  three instant withdrawals paid from the buffer  ($100 / $239.85 / $510.15)
    PASS  three exits above the buffer queued at the request price  ($35,550.05 owed, buffer was $20,042.48)
    PASS  the keeper brought cash home and the queue paid every claim in full  ($35,550.05 in 45s)
    PASS  three distinct claims in the vault's queue, all settled  (claims #27, #28, #29)
    PASS  compliance revokes a lender with an ML-DSA-87 signature
    PASS  a revoked lender cannot pass agUSD on
    PASS  a revoked lender can still take its money out  ($4,319.46)
    PASS  the next epoch (15) leaves the revoked lender out
    PASS  totalAssets = idle + deployed - pending - unvested
    PASS  the queue is empty
    PASS  bridge at rest: everything sent was received, everything sent home returned  ($547,884.03 out, $400,448.03 back)
    PASS  the vault's mark is within 1% of the book  (vault $147,447.19, book $147,448.41)
    PASS  the share price did not fall during the battery  (1.014818 -> 1.014821)
    PASS  every lender transaction: secp256k1 and ML-DSA-87 both verify (QoreSign)  (31 transactions)
    42/42 checks passed, 31 lender transactions, 10 min
