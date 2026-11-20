# Findings

Everything the tests, the end-to-end runs, the batteries and the live keeper turned up, and what was done.
Latest battery: [docs/battery](battery/), **42/42** with 8 lenders against the production keeper.

| # | Found by | Finding | Status |
|---|---|---|---|
| 1 | Foundry invariant (seed 3) | `AgUSD._recognizeGain` underflowed (`vested - fee`) once a loss left the vault holding less than the queue is owed, so no upward mark could ever be recorded again. | **Fixed**: a gain is capped at what holders own; regression test. The Whitechain vault it was ported from has the same code (open there). |
| 2 | Live keeper | A NAV report read `totalSent` from a node one block behind the vault's `deployedAssets`: an allocation looked lost and the vault was marked down 5% (price 0.955). | **Fixed**: every chain read at one block; a mark-down only once it persists 15 min. The wrong mark was undone with the fee at 0 (`remark.ts`), so holders paid no fee on the recovery. |
| 3 | Gas receipts | QoreChain charges the whole gas limit, not the gas used: round ceilings cost 3 to 5 times the work. | **Fixed**: limits are the estimate plus 25%. |
| 4 | Redeploy e2e | Publishing a KEM key already in the registry is refused (`pqc` 253), which failed the whole QoreX transaction. | **Fixed**: the registry message is sent only when the key differs (keeper and app). |
| 5 | Gas tank | A spending-rule refusal lands with code 0; the refusal is an `abstractaccount_execution_failed` event, and the REST tx does not carry `msg_responses`. | **Fixed**: the event is read; e2e checks a payment over the limit is refused. |
| 6 | Browser e2e | The QoreX test double reads `account_info`, which the REST proxy did not forward: every signature failed with "account does not exist". | **Fixed**: route allowed. |
| 7 | Browser e2e | A fresh browser has no QoreSeal seed for an account whose key is already on chain. | **By design**: the app offers restore from the backup file; the e2e keeps its seed like a user keeps the backup. |
| 8 | CI | Three web components were never committed; the local build hid it. | **Fixed**. |
| 9 | CI | `next/font/google` fetches fonts at build time and failed at random on GitHub runners. | **Fixed**: Inter and Space Grotesk self-hosted. |
| 10 | Battery 1 | An instant withdrawal sent in the same block as large queued exits reverts: a queued claim settles from the buffer as soon as it is made (FIFO), so the buffer the app saw is gone. | **Mitigated**: correct by design (first in, first out); the app now says so and offers to queue, and agUSD is untouched. |
| 11 | Battery 1 | The issuer wires a subscription to the book one keeper tick after it arrives, not in the same block. | **Not a bug**: the battery waits for it. |
| 12 | Dependencies | `@qorechain/qore-cli` was refused by the team's npm guard (published 4 days before, no provenance). | **Decision**: left out; the same check is done with QoreSign `verifyHybridTx`. |
| 13 | Threat model / QoreScan | The Ethereum leg's attestation is secp256k1 (Ethereum cannot verify ML-DSA-87 cheaply). | **Open, stated**: see THREAT_MODEL.md. QoreChain Bridge (QCB), PQC-attested, is the path when its routes go live. |
| 14 | Battery 2 | Checks read too tightly: per-second profit unlocking moves the price between a deposit and the next read, and a claim the buffer covers is paid and deleted inside the transaction that makes it. | **Not a bug**: the battery values claims before sending them and tolerates unlocking. |
| 15 | Battery 3 | A refused lender's failing transactions cost their whole gas limit (finding 3 again) and drained its QOR mid-battery; two batteries had also left 18 QOR idle in test accounts. | **Fixed**: refused profiles get what their failures cost, tight limits on transactions meant to fail, and `sweep.ts` returns leftovers to the operator. |
