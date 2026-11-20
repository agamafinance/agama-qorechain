# Architecture

```
contracts/   Solidity 0.8.28, Foundry, OpenZeppelin 5.4, QoreChain Asset Kit
  pqc/       PqcAuth (pqcVerify + pqcKeyStatus), PqcSigned (single-use signed actions), PqcGoverned (PQ admin)
  qore/      AgUSD, AccessRegistry, DataRoom, CrossChainAllocator, AgamaComplianceModule, FestUsdOnRamp
  cctp/      AttestedMessenger (CCTP V2), PqAttestedMessenger (QoreChain), EcdsaAttestedMessenger (Ethereum)
  l1/        AgamaL1Receiver, AbfAssetIssuer (Ethereum Sepolia)
keeper/      TypeScript: @qorechain/sdk, qoreseal, qoresign, pqc, viem
  accounts   role accounts (coin 60, indexes 10-14) and the funding QoreX account (coin 118)
  keys       ML-DSA-87 registration with PoP, ML-KEM-1024 publication, scoped EVM window
  cards      QoreSign-signed QoreSeal recipient cards for the officers
  deploy     both legs, idempotent, every admin step ML-DSA-87 signed
  relay      CCTP messages both ways: secp256k1 attestations to Ethereum, ML-DSA-87 to QoreChain
  vault      allocate above the floor, refill under half, NAV reports signed by the reporter
  book       the simulated ABF issuer: wire to custody, accrue, mark, bring collections home
  compliance open sealed dossiers, verify their filing transaction (QoreSign), decide, seal the letter, sign
  dataroom   an epoch per membership change, the loan tape as a QoreSeal private batch
  cli        one tick does all of the above; `loop` ticks every 3 min and at once when work appears
  e2e        the whole route on the live testnets, as a QoreX lender
web/         Next.js 16, viem, @qorechain/qoreseal, @qorechain/qorex-types
  Earn, Access, Data room, Portfolio, Faucet; QoreSeal runs in the browser; QoreX signs every write
abi/         typed ABIs for the app, generated from the forge build
deployments/ every address, role and wiring step; v1 kept for the record
docs/cbom/   QoreScan: CBOM, DORA mapping, crypto-agility template
```

## Lender accounts: PqAccount

QoreX signs only what it can display, and it cannot display a cross-VM call. So a lender never sends a transaction
to Agama. Its Agama account is a `PqAccount`, a contract at an address fixed by its owner alone (CREATE2 from the
`PqAccountFactory`), and the only thing that moves it is a message the owner signs in QoreX:

```
"qorechain-msg-v1|qorechain-diana|" ‖ summary ‖ "\n\nAgama account " ‖ account ‖ "\nnonce " ‖ n ‖ "\nvalid until " ‖ t ‖ "\ncalls " ‖ keccak256(abi.encode(calls))
```

1. The app builds the calls (faucet, approve + deposit, redeem, the encryption key, the sealed application) and asks
   QoreX to sign the text (`signArbitrary`: ADR-36 secp256k1 + ML-DSA-87). The lender reads what it signs.
2. The relayer (`keeper/src/pqaccounts.ts`) checks both halves against the keys on chain with QoreSign, then sends
   `factory.execute`. It pays the gas, from its own scoped EVM window.
3. The account rebuilds the text, reads its owner's key from `pqcKeyStatus`, verifies the ML-DSA-87 signature with
   `pqcVerify`, bumps its nonce and makes the calls, to Agama's three contracts only.

The relayer can delay a message, never change one: a different call, amount, summary, account, chain or nonce is a
different text. A rotated key applies at once. The factory owns the Asset Kit's hybrid holder guard and exempts
each account it creates, only for an owner whose ML-DSA-87 key is registered with proof of possession.

## Why each piece is where it is

**The vault is on QoreChain, the book on Ethereum.** The lender's identity, its signatures and the confidential
data live where post-quantum signatures and encryption keys are native. The book is where the asset issuer is.
Crossing uses Circle's CCTP V2 message layout, so moving to Circle when it gives QoreChain a domain is a
constructor argument.

**Permission is a policy, not a whitelist.** agUSD asks one `IHolderEligibility` (the Asset Kit interface) whether an
account may hold it. The AccessRegistry answers: approved by a signed decision, not expired, and still a hybrid
holder per the Asset Kit's `QoreChainHybridHolderGuard`. The same policy plugs into any ERC-3643 token through
`AgamaComplianceModule`.

**Ciphertext goes where it is cheapest to find.** A lender's own writes arrive through `MsgCrossVMCall`, whose EVM
logs the chain does not serve over `eth_getLogs`, so what lenders write (keys, dossiers, redemption ids) is kept in
contract storage. What the keeper writes (letters, epoch distributions, tapes) goes in events from the EVM lane, with
the block number kept in storage so a reader finds it in one query.

**Epoch keys are derived, not stored.** `HKDF(manager's QoreSeal seed, "epoch|n")`: the keeper runs on ephemeral CI
machines and a key it had to remember would be a key it could lose. The QoreSeal envelopes carry each key to the
members.

**Gas is estimated, never padded.** QoreChain charges the gas limit, not the gas used.

## Measured on qorechain-diana

| Operation | Gas |
|---|---|
| Publish encryption key (KEM registry + AccessRegistry), from QoreX | ~1.8M |
| File a 3.6 kB sealed dossier, from QoreX | ~3.7M |
| Approve with ML-DSA-87 (pqcVerify) and a sealed letter | ~1.0M |
| Faucet + approve + deposit, one QoreX transaction | ~0.85M |
| Data room epoch, 2 members + auditor, signed | ~0.47M |
| Loan tape (3.3 kB batch), signed | ~0.39M |
| Settle a return with an ML-DSA-87 attestation | ~0.32M |
