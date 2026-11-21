# Battery after the switch to the native lane (2026-11-21)

Every write Agama's accounts make on QoreChain is now a hybrid-signed (secp256k1 + ML-DSA-87) native
`MsgCrossVMCall`; every role's EVM window is closed (FINDINGS 21). All suites rerun against the production keeper
(GitHub Actions) and the deployed app (app.agama.finance/qorechain, relayer on Vercel), on qorechain-diana and Sepolia.

| Suite | Result |
|---|---|
| Bridge rebuild (`keeper/src/bridge-check.ts`) | **37/37** allocation messages rebuilt from calldata and state, identical to their `MessageSent` logs |
| Bridge round trip, native both ways | `settleReturn` `0859B119…` (30 USDC home), `allocate` `649917EA…` relayed to Sepolia `0x8ae91b45…`; the e2e and battery crossed again (`E741A474…`, `5F73333C…`) |
| Protocol e2e (`keeper/src/e2e.ts`) | **30/30** with the fest fUSD leg (fUSD claimed on five faucet addresses and collected with `collect.ts`; an earlier run without fUSD: 29/29, that leg skipped) |
| PqAccount battery (`keeper/src/pq-battery.ts`, PQ_BASE=32) | **26/26** |
| Protocol battery (`keeper/src/battery.ts`, BATTERY_BASE=200) | **42/42** with the fest fUSD legs, 31 lender transactions, 7 min (at BATTERY_BASE=56, indexes an older battery had approved, two refusal checks read a balance those accounts already held: the checks now compare before and after) |
| PqAccount checks (`keeper/src/pq-check.ts`) | **7/7** |
| Browser, simple path (`web/e2e/onboarding.mjs`, production) | **7/7** |
| Browser, full path (`web/e2e/browser.mjs`, production) | **9/9**, four runs in a row |
| Browser, locked QoreX (`web/e2e/locked.mjs`, production) | **pass**; the toast links the native hash |
| Explorer (`web/e2e/explorer.mjs`) | **12/12** kinds (11 below, and the keeper's NAV mark `186ADE12…`) shown *quantum-safe, verified on-chain*, ML-DSA-87 |
| Post-quantum audit (`keeper/src/pq-audit.ts`) | **278/278** transactions since the switch hybrid-verified; no window open; an ECDSA-only EVM transaction from the operator and from the relayer refused by the chain |

## Explorer

```
PASS  lender action (faucet)       6A0A35377810…  0 async max factor 0 Signature security quantum-safe verified on-chain Post-quantum algorithm ML-DSA-87 (Dilithi
PASS  lender filing (dossier)      2A486F2DF965…  0 async max factor 0 Signature security quantum-safe verified on-chain Post-quantum algorithm ML-DSA-87 (Dilithi
PASS  compliance approve           75AE2BE0E09F…  0 async max factor 0 Signature security quantum-safe verified on-chain Post-quantum algorithm ML-DSA-87 (Dilithi
PASS  compliance reject            31F7FFFFD3CF…  0 async max factor 0 Signature security quantum-safe verified on-chain Post-quantum algorithm ML-DSA-87 (Dilithi
PASS  compliance revoke            326CDA847943…  0 async max factor 0 Signature security quantum-safe verified on-chain Post-quantum algorithm ML-DSA-87 (Dilithi
PASS  data room epoch              67D16EBC9534…  0 async max factor 0 Signature security quantum-safe verified on-chain Post-quantum algorithm ML-DSA-87 (Dilithi
PASS  data room tape               CF34E871BAA5…  0 async max factor 0 Signature security quantum-safe verified on-chain Post-quantum algorithm ML-DSA-87 (Dilithi
PASS  bridge allocate (out)        54E464036FC6…  0 async max factor 0 Signature security quantum-safe verified on-chain Post-quantum algorithm ML-DSA-87 (Dilithi
PASS  bridge settleReturn (in)     35BBC340ED39…  0 async max factor 0 Signature security quantum-safe verified on-chain Post-quantum algorithm ML-DSA-87 (Dilithi
PASS  keeper funding (MsgSend)     6E0EFD053B6A…  hf3r2 amount 2.2 QOR Signature security quantum-safe verified on-chain Post-quantum algorithm ML-DSA-87 (Dilithi
PASS  window close                 CF790C406B2A…  or1qvc7jv…vny6kskgly Signature security quantum-safe verified on-chain Post-quantum algorithm ML-DSA-87 (Dilithi

11/11 transactions shown "quantum-safe · verified on-chain" with ML-DSA-87
```

## Post-quantum audit

```
reporter      0 txs, 0 hybrid-verified  [none]
compliance    0 txs, 0 hybrid-verified  [none]
attester      0 txs, 0 hybrid-verified  [none]
auditor       0 txs, 0 hybrid-verified  [none]
relayer      97 txs, 97 hybrid-verified  [MsgCrossVMCall x95, MsgSend x1, MsgCloseEVMWindow x1]

207/207 transactions of Agama's accounts since 2026-11-21T09:45:00.000Z carry a hybrid signature the chain verified
EVM windows open: none
REFUSED  ECDSA-only EVM tx from operator: failed to broadcast transaction: account qor1qvc7jve4se89maha3sn2cedn589dvny6kskgly has no open EVM authorisation window; open one with MsgOpenEVMWindow, signed on the Cosmos lane with the account's post-quantum key: no open EVM authorisation window: no open EVM authorisation window [cosmossdk.io/errors@v1.0.2/errors.go:77]
REFUSED  ECDSA-only EVM tx from relayer: failed to broadcast transaction: account qor1pxv6l32qguyrv3xp0hpxehqd9mmlcdwp8c3qmg has no open EVM authorisation window; open one with MsgOpenEVMWindow, signed on the Cosmos lane with the account's post-quantum key: no open EVM authorisation window: no open EVM authorisation window [cosmossdk.io/errors@v1.0.2/errors.go:77]

PASS: post-quantum end to end
```

## Protocol e2e

```
PASS  lender's EVM twin is quantum safe (pqcKeyStatus)  (ML-DSA-87 key of 2592 bytes, possession proven)
PASS  ML-KEM-1024 key in QoreChain's KEM registry
PASS  same key bound in the AccessRegistry
PASS  dossier on chain is ciphertext only  (3625 bytes, QSEL envelope)
PASS  the dossier is not readable without an officer's key
PASS  the auditor's view key opens it
PASS  lender approved and eligible
PASS  lender opens its sealed decision letter  (Professional, until 2027-05-18)
PASS  the letter names the dossier the officer read
PASS  the officer verified the filing transaction's two signatures (QoreSign)  (tx 9E0C553AF120…)
PASS  an ERC-3643 token using AgamaComplianceModule would admit the lender
PASS  agUSD minted to the approved lender  (9851.907824 agUSD)
PASS  a stranger cannot be sent agUSD (maxDeposit 0)
SKIP  fest fUSD on-ramp: no fest fUSD left (lender 0, operator 0); claim it at the fest faucet
PASS  vault buffer within its policy band, the rest at work  ($21,455.77 of $214,343.36 (10.0%))
PASS  allocation burned on QoreChain arrived on Ethereum  ($8,998.94)
PASS  issuer wired the subscription to the book  (book $173,607.7)
PASS  lender is a member of the current epoch  (epoch 17)
PASS  lender decrypts the loan tape  (12 facilities, book $173,607.7, 30dpd 8.99%)
PASS  ciphertext commitment matches the chain
PASS  the auditor opens the same epoch
PASS  an outsider's key does not open it
PASS  exit queued at today's price  ($21,415.36 for claim #31)
PASS  queue paid the lender in full  ($21,415.36)
PASS  gas tank pays the operator 1 QOR from the treasury, inside the rule
PASS  the chain refuses a payment over the per-payment limit  (per-tx limit 5000000uqor exceeded (attempted 6000000): spending limit )
PASS  every lender transaction: secp256k1 and ML-DSA-87 both verify (QoreSign)  (2 transactions)
PASS  operator: no EVM window, and an ECDSA-only EVM transaction is refused by the chain  (failed to broadcast transaction: account qor1qvc7jve4se89maha3sn2cedn589dvny6kskgly has no)
PASS  relayer: no EVM window, and an ECDSA-only EVM transaction is refused by the chain  (failed to broadcast transaction: account qor1pxv6l32qguyrv3xp0hpxehqd9mmlcdwp8c3qmg has no)
PASS  every transaction Agama's accounts sent during this run carries a verified hybrid signature  (5/5)
29/29 checks passed
```

## PqAccount battery

```
PASS  A: PqAccount created by its first message, application filed  3517 bytes sealed, D26BD6B43427…
PASS  B: PqAccount created by its first message, application filed  3525 bytes sealed, 48E30E35F8A2…
PASS  C: PqAccount created by its first message, application filed  3509 bytes sealed, 7FFB7E49EFC8…
PASS  D: PqAccount created by its first message, application filed  3515 bytes sealed, D86239792051…
PASS  A: approved  Approved
PASS  A: opens its own sealed letter; the officer verified the PqAccount filing  Professional
PASS  B: approved  Approved
PASS  B: opens its own sealed letter; the officer verified the PqAccount filing  Institutional
PASS  C: rejected  Rejected
PASS  C: opens its own sealed letter; the officer verified the PqAccount filing  The note is reserved to professional, institutional and accredited investors.
PASS  D: rejected  Rejected
PASS  D: opens its own sealed letter; the officer verified the PqAccount filing  The note cannot be offered to residents of US.
PASS  A: deposit, approval and deposit in one message  2955.571172 agUSD
PASS  A: instant withdrawal from the buffer
PASS  A: queued withdrawal recorded, priced at the request  request #32
PASS  A: the queue is settled from the buffer, paid to the PqAccount  next to settle #33
PASS  B: deposit, approval and deposit in one message  2955.571088 agUSD
PASS  B: full withdrawal
PASS  C: a deposit by a rejected lender is refused
PASS  D: a deposit by a rejected lender is refused
PASS  agUSD cannot be sent to a rejected lender's PqAccount
PASS  a PqAccount cannot be told to call anything but Agama's contracts
PASS  A: no EVM window, no grant, no QOR spent  1.01 QOR
PASS  B: no EVM window, no grant, no QOR spent  1.01 QOR
PASS  C: no EVM window, no grant, no QOR spent  1.01 QOR
PASS  D: no EVM window, no grant, no QOR spent  1.01 QOR
26/26 PqAccount battery checks passed
```

## Protocol battery

```
SKIP  treasury sends 50 fest fUSD to two lenders: the funding account has no fest fUSD left (claim it at the fest faucet)
PASS  8 lenders registered ML-DSA-87 keys and published ML-KEM-1024 keys in parallel  (8/8)
PASS  8 sealed dossiers on chain, none readable in clear  (3552, 3552, 3551, 3554, 3559, 3558, 3538, 3549 bytes)
PASS  the keeper decided all 8 dossiers  (in 51s after filing)
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
PASS  six concurrent deposits all minted agUSD  (985 / 2462 / 4925 / 7388 / 11822 / 19703)
PASS  each lender got agUSD worth what it paid, to 0.1%  (price 1.015032)
PASS  vault assets grew by the deposits  ($48,000 in)
SKIP  50 fest fUSD into the vault's dollar: no fest fUSD to test with
PASS  agUSD moves between two approved lenders
PASS  agUSD cannot be sent to a refused account
PASS  the keeper sent the new money to Ethereum and every burn was minted there  ($43,195.2 in 51s)
PASS  the vault kept its 10% buffer  ($24,797.59 of $247,728.14)
PASS  the issuer wired up to its 90% cap to the book  (book $200,646.24, cash $22,294.03)
PASS  all six approved lenders decrypt tape #27 of epoch 20  (58 members in 8 parts, 14.4 kB each at most)
PASS  neither refused lender can open the epoch key
PASS  three instant withdrawals paid from the buffer  ($100 / $239.85 / $510.15)
PASS  three exits above the buffer queued at the request price  ($35,550 owed, buffer was $24,797.59)
PASS  the keeper brought cash home and the queue paid every claim in full  ($35,550 in 30s)
PASS  three distinct claims in the vault's queue, all settled  (claims #33, #35, #34)
PASS  compliance revokes a lender with an ML-DSA-87 signature
PASS  a revoked lender cannot pass agUSD on
PASS  a revoked lender can still take its money out  ($2,158.65)
PASS  the next epoch (21) leaves the revoked lender out
PASS  totalAssets = idle + deployed - pending - unvested
PASS  the queue is empty
PASS  bridge at rest: everything sent was received, everything sent home returned  ($642,652.18 out, $452,506.08 back)
PASS  the vault's mark is within 1% of the book  (vault $190,179.7, book $190,183.29)
PASS  the share price did not fall during the battery  (1.015032 -> 1.015033)
PASS  every lender transaction: secp256k1 and ML-DSA-87 both verify (QoreSign)  (30 transactions)
40/40 checks passed, 30 lender transactions, 7 min
```
