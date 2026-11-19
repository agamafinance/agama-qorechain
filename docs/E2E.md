# End to end

Both suites run against the live testnets, with the keeper running as it does in production.

## On chain (`keeper/src/e2e.ts`, 25 checks)

A lender that is a QoreX-style account (coin 118, canonical ML-DSA-87 key registered) does everything through
hybrid-signed native transactions and MsgCrossVMCall, exactly as QoreX does:

1. publishes an ML-KEM-1024 key in the KEM registry and the AccessRegistry, one transaction
2. files a KYC dossier sealed to the compliance officer and the auditor; the chain holds ciphertext only, the lender
   cannot open it, the auditor can
3. the officer verifies the filing transaction's two signatures (QoreSign), opens the dossier, approves it with
   ML-DSA-87 (pqcVerify); the lender opens the sealed letter, which names the dossier hash; an ERC-3643 token using
   `AgamaComplianceModule` would admit it
4. faucet + approve + deposit in one transaction; a stranger cannot receive agUSD
5. 100 fest fUSD: `MsgConvertCoin` + approve + `FestUsdOnRamp.onRamp`, one transaction
6. the vault keeps 10%, the rest is burned on QoreChain, minted on Ethereum, subscribed, wired to the book
7. the data room's epoch includes the lender; it decrypts the loan tape, whose ciphertext matches its on-chain
   commitment; the auditor opens the same epoch; a stranger's key does not
8. a queued exit larger than the buffer is paid in full from collections burned home under an ML-DSA-87 attestation
9. every lender transaction is re-verified with QoreSign: secp256k1 and ML-DSA-87

Last run, 19 November 2026: **25/25**.

## In the browser (`web/e2e/browser.mjs`, 9 checks)

The real app, the official QoreX test double (`@qorechain/qorex-wallet-mock`, real hybrid signing and broadcast)
and a fresh lender account: connect, create and publish the QoreSeal key, seal and file the application, approval
by the running keeper and the letter opened in the page, faucet, deposit, portfolio, data room decrypted (12
facilities, commitment checked), no page errors.

Last run, 19 November 2026: **9/9**. Screenshots in `web/e2e/shots/`.

## Contracts (`forge test`, 170 tests)

Unit, fuzz and 6 invariants, with the precompiles mocked: every way a PQ authorisation can be wrong, the registry,
the permission gate, the vault's accounting, both messenger legs, the round trip, the data room, the ERC-3643
module and the fUSD on-ramp.
