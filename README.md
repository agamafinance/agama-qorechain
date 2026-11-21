# Agama on QoreChain

**Private credit for permissioned lenders, sealed against Q-Day.**

Agama is a private credit vault: lenders deposit dollars, hold **agUSD**, and the yield of an asset-backed credit
book lands in the share price. On QoreChain it becomes what private credit has always needed and a public chain
could not give it: **a permissioned vault where nobody's identity and nobody's loan file is ever public, and where
no key a quantum computer could break can move the money.**

- Lenders apply with a **KYC dossier encrypted in their browser** with ML-KEM-1024 (QoreSeal) to the compliance
  officer and the auditor. The chain stores ciphertext only.
- The decision is an **ML-DSA-87 signature checked on chain by `pqcVerify`**, and the decision letter is sealed back
  to the lender, who opens it in the browser.
- The vault's **loan tape lives on chain, encrypted** to the approved lenders and the auditor, with a new group key
  at every membership change. Lenders decrypt it in the browser.
- The capital crosses to Ethereum to the asset issuer and comes back **attested with ML-DSA-87**: every dollar that
  lands on QoreChain was signed post-quantum.
- **Post-quantum accounts.** Each lender's Agama account is a contract (`PqAccount`) controlled only by the
  ML-DSA-87 key of its QoreX account. Every action is a message signed in QoreX; the account verifies the signature
  **on chain with QoreChain's `pqcVerify`** before it acts. No EVM window, no grant, no gas for the lender.
- **Nothing Agama sends on QoreChain is ECDSA-only.** The relayer and the keeper write through hybrid-signed
  (secp256k1 + ML-DSA-87) native `MsgCrossVMCall` transactions: the explorer shows every one *quantum-safe, verified
  on-chain*. No role has an EVM window, and the chain refuses an ECDSA-only transaction from any of them
  (`keeper/src/pq-audit.ts`). The bridge, the data room and the compliance officer read what those calls carry from
  the committed transactions, since a cross-VM call leaves no EVM log.

Built for **Build Before Q-Day**, the QoreChain Developer Fest, on `qorechain-diana`, during the fest.
Category: **Encrypted Apps**.

> Live on the QoreChain and Ethereum Sepolia testnets. Tests: 190 Foundry, a 42-check battery of 8 lenders against the production keeper, 27 on-chain e2e checks, 9 browser e2e
> checks with the official QoreX test double.

## What happens to a lender

```
 Browser (QoreX)                         QoreChain diana (EVM 9800)                 Ethereum Sepolia
 ───────────────                         ──────────────────────────                 ────────────────
 1 QoreSeal key pair made here  ──────►  KEM registry (MsgRegisterKEMKey)
   (ML-KEM-1024 + X25519)                AccessRegistry.publishEncryptionKey
                                           only for a proven ML-DSA-87 account
                                           (Asset Kit QoreChainHybridHolderGuard)
 2 KYC sealed to officer + auditor ────► AccessRegistry.fileDossier  (ciphertext)
   hybrid, cards verified (QoreSign)
                                         keeper / compliance officer:
                                           finds the filing tx, verifies both
                                           signatures (QoreSign verifyHybridTx),
                                           opens the dossier, decides, seals the
                                           letter, signs ML-DSA-87
                                         AccessRegistry.approve ── pqcVerify ✓
 3 letter opened here  ◄──────────────── Approved(letter = sealed envelope)
 4 deposit (one QoreX signature) ──────► agUSD (ERC-4626, permissioned)
                                           10% buffer stays, the rest:
                                         CrossChainAllocator ── burn (CCTP V2) ───►  AgamaL1Receiver
                                                                 secp256k1 attest    AbfAssetIssuer (ERC-4626,
                                                                                      allowlisted) → custody,
                                                                                      off-chain ABF book
                                         reportNav ── ML-DSA-87, pqcVerify ✓  ◄──── NAV of the position
                                         settleReturn ◄─ ML-DSA-87 attested ◄─────── collections, burned home
 5 data room: epoch key opened here ◄─── DataRoom epoch (key sealed to members)
   loan tape decrypted here       ◄───── DataRoom report (QoreSeal private batch)
```

## Where QoreChain's post-quantum stack is used

| Action | Protected by | Checked by |
|---|---|---|
| Every lender transaction (key, dossier, deposit, exit, fUSD swap) | QoreX hybrid signature, secp256k1 + ML-DSA-87 | the chain's ante handler; again off chain with QoreSign `verifyHybridTx` (by the officer for every dossier, by the e2e for every lender transaction) |
| Lender's encryption key | ML-KEM-1024 key in QoreChain's **KEM registry** and the AccessRegistry | AccessRegistry refuses accounts the Asset Kit guard does not see as hybrid holders |
| KYC dossier | QoreSeal envelope, hybrid ML-KEM-1024 + X25519, to the officers' registered keys, their QoreSign recipient cards verified | only the compliance officer and the auditor can open it |
| Compliance decision | officer's ML-DSA-87 signature over the exact dossier hash | `pqcVerify` (0x0a01) against `pqcKeyStatus` (0x0a02) |
| Decision letter | QoreSeal envelope to the lender and the auditor, bound to the lender's address | opened in the browser |
| Who may hold agUSD | approval, not expired, and still a hybrid holder | agUSD `_update` on every mint and transfer (burns are never gated) |
| Loan tape | QoreSeal epoch keys + private batches, SHA3-256 commitments | members and the auditor decrypt; outsiders cannot |
| Epochs and tapes | manager's ML-DSA-87 signature | `pqcVerify` |
| NAV report | reporter's ML-DSA-87 signature (the reporter never sends a tx) | `pqcVerify`, plus interval and max-move guards |
| Money coming home from Ethereum | attester's ML-DSA-87 signature over the CCTP message | `pqcVerify` in `PqAttestedMessenger` |
| Money going out to Ethereum | attester's secp256k1 signature **and** ML-DSA-44 (FIPS 204), or a hash-based Merkle WOTS+ one-time signature | `HybridAttestedMessenger` on Sepolia: ML-DSA-44 verified in Solidity (ZKNox), ~8.3M gas; no owner, rotation only by both keys ([docs/PQ_ETHEREUM.md](docs/PQ_ETHEREUM.md)) |
| Every admin power (config, roles, receivers, attester, officer, manager) | admin's ML-DSA-87 signature | `pqcVerify`; no function checks `msg.sender` for admin powers |
| Every transaction Agama's relayer and keeper send | hybrid signature, secp256k1 + ML-DSA-87, native `MsgCrossVMCall` (no EVM window, none open) | the chain's ante handler (`pqc_hybrid_verify`); `pq-audit.ts` checks every one, and that an ECDSA-only EVM transaction from a role is refused |
| Keeper's gas | an ed25519 **authenticator** linked to the treasury: `send` QOR only, 5 per payment, 15 a day, 29 days | the chain's spending rule (`abstractaccount`); the treasury's keys never reach the keeper |
| Pause | guardian (classical key) | can only stop new money; never costs a holder anything |

Every ML-DSA-87 signature the keeper produces is first verified locally with **qorechain-pqc** against the key the
chain holds for that role, so a mismatched key fails for free instead of as a reverted transaction.

## Kits and network functions

**Kits:** QoreChain SDK (TypeScript), QoreSeal (TypeScript), QoreSign (TypeScript), qorechain-pqc (TypeScript),
QoreX integrations (`@qorechain/qorex-types`, `@qorechain/qorex-wallet-mock`), Asset Kit (Solidity:
`QoreChainHybridHolderGuard`, `IHolderEligibility`, `IERC3643ComplianceModule`), QoreScan (CBOM, DORA mapping, agility template in `docs/cbom`).

**Network functions:** ML-DSA-87 hybrid transactions; PQC key registration with proof of possession; EVM windows
(closed: their refusal of ECDSA-only transactions is tested); PQC signature verification in Solidity (`pqcVerify`); PQC key status in Solidity (`pqcKeyStatus`); QoreSeal
and the encryption key registry (`MsgRegisterKEMKey`); Fest test tokens (fUSD, via `MsgConvertCoin` and the
`FestUsdOnRamp`); cross-VM calls (native to EVM, `MsgCrossVMCall`); smart accounts and spending rules (the keeper's gas tank); Asset
Kit; QoreScan.

## Contracts

`contracts/` · Solidity 0.8.28, Foundry, OpenZeppelin 5.4, Asset Kit. **190 tests** (unit, fuzz, 6 invariants, post-quantum verifier vectors).

| Contract | Chain | What it does |
|---|---|---|
| `pqc/PqcAuth`, `PqcSigned`, `PqcGoverned` | QoreChain | ML-DSA-87 checks via the precompiles; single-use, domain-separated signed actions; an admin that is only a PQ key |
| `qore/AccessRegistry` | QoreChain | encryption keys, sealed dossiers, signed decisions; an Asset Kit `IHolderEligibility` policy |
| `qore/AgUSD` | QoreChain | the permissioned ERC-4626 vault: buffer, FIFO exit queue, vested profit, ML-DSA-87 NAV and governance |
| `qore/DataRoom` | QoreChain | epochs and sealed reports, ML-DSA-87 signed |
| `qore/CrossChainAllocator` | QoreChain | the vault's only route to the book, over CCTP V2 messages |
| `qore/AgamaComplianceModule` | QoreChain | Agama's sealed KYC as an ERC-3643 compliance module, for any permissioned token |
| `qore/FestUsdOnRamp` | QoreChain | the fest's fUSD into the vault's dollar, one to one, and back |
| `cctp/PqAttestedMessenger` | QoreChain | CCTP V2 burn-and-mint; inbound attestations are ML-DSA-87, checked by `pqcVerify` |
| `cctp/HybridAttestedMessenger` | Ethereum | the same, minting only with secp256k1 AND a post-quantum proof; no owner |
| `cctp/pq/MlDsa44AttestationVerifier` | Ethereum | ML-DSA-44 (FIPS 204) in Solidity, on ZKNox's NIST verifier |
| `cctp/pq/MerkleWotsAttestationVerifier` | Ethereum | Merkle WOTS+ (XMSS construction on keccak256), leaves spent once on chain |
| `cctp/EcdsaAttestedMessenger` | Ethereum | the first, secp256k1-only Ethereum leg (retired, can no longer mint) |
| `l1/AgamaL1Receiver`, `l1/AbfAssetIssuer` | Ethereum | agUSD's position and the simulated ABF issuer (allowlisted ERC-4626 note) |

### Addresses (v2)

QoreChain `qorechain-diana`, EVM chain id 9800:

| | |
|---|---|
| agUSD vault | `0x0ed07a6af9e1e78c0166a3c02133ac994268be5d` |
| AccessRegistry | `0x032492a0dc1159d781025a82a3999faf2d360441` |
| DataRoom (v2, key in parts) | `0x06b89566a2eef09c964522445ba578dc710ea815` |
| PqAttestedMessenger | `0x0afb58ce8aa5be74251e61e7b9404529d6087013` |
| CrossChainAllocator | `0x7e913de8003c0ad626fd2c44d56efea13c28fb17` |
| QoreChainHybridHolderGuard (Asset Kit) | `0xa112c61bff6439b11ea96ffc20cd121db3f0739a` |
| AgamaComplianceModule | `0xebcb8d74fb8354c55dc750a7feaeed46d123b391` |
| FestUsdOnRamp | `0x8cecfcd4ccb825d877baee30c52153bc6828b712` |
| Mock USDC | `0xa57f460cd0b27612e870963c20b9a27d11ddc608` |

Ethereum Sepolia: hybrid messenger `0x90d29f6947d7bfbb828851eabdd4b78bf416b9ae`, receiver `0x0f66e08672786cba567729982570df9827b65d60`, ML-DSA-44 verifier
`0xec11b12ad44f1cb4218015f86f5d2938fdcfeb8e`, Merkle WOTS+ verifier `0x717c5e2974e33096a8c84b6eec1bed36669a10d4`, issuer `0xc0f1d29f7778a663f3502afe9acb467d065d993f`,
mock USDC `0x1c8669b4e26a642d83748984d19dd5149af8c42b`. Everything is in `deployments/`.

### Testnet accounts (`qor1`)

| Role | Address | Keys |
|---|---|---|
| Operator, admin, guardian | `qor1qvc7jve4se89maha3sn2cedn589dvny6kskgly` | ML-DSA-87 (registered, PoP); sends native hybrid transactions only, no EVM window |
| NAV reporter | `qor1gp6jjx2u7h6vrcv2h4rtsxp0al8h4mv37sn064` | ML-DSA-87 only signs |
| Compliance officer, data room manager | `qor17q0jps4cvvg2x6xm3d2d44pev4shh4lx3x50re` | ML-DSA-87 + ML-KEM-1024 (KEM registry) |
| Bridge attester | `qor122d73j03vxdzvwlpvzdze30s0gejn2q8g252h7` | ML-DSA-87 towards QoreChain; secp256k1 + ML-DSA-44 (or WOTS+) towards Ethereum |
| Auditor (view key) | `qor1z0y4zrt2pkxmrgzzvh2cws5azlvf66zckvkx9w` | ML-KEM-1024 (KEM registry) |
| Relayer (pays lenders' gas) | `qor1pxv6l32qguyrv3xp0hpxehqd9mmlcdwp8c3qmg` | ML-DSA-87 (registered, PoP); native hybrid transactions only, no EVM window |

## Run it

```bash
git clone --recursive https://github.com/agamafinance/agama-qorechain && cd agama-qorechain

cd contracts && forge test && cd ..            # 190 tests, mock precompiles locally

cd web && pnpm install && pnpm build && pnpm start   # http://localhost:3034/qorechain
```

Install QoreX and connect. Then: **Faucet** (mock USDC), **Earn** (get verified and deposit in one card), **Data
room**, **Portfolio**. Every action is one signature; Agama pays the gas. Locally: `cd keeper && npx tsx
src/relayer.ts` next to the web app.

Operating a deployment (testnet mnemonics only, never committed: `~/.config/qorechain/testnet.mnemonic` for the
roles, `~/.config/qorechain/agama-funder.mnemonic` for the funding QoreX account):

```bash
cd keeper && npm install
npx tsx src/keys.ts status                    # roles: QOR, ML-DSA-87, ML-KEM-1024, EVM window (none)
npx tsx src/fund.ts 55 3 8 3 3                # QOR to operator, reporter, compliance, attester, auditor
npx tsx src/keys.ts register all              # ML-DSA-87 keys with proof of possession
npx tsx src/keys.ts kem all                   # officers' ML-KEM-1024 keys in the KEM registry
npx tsx src/cards.ts                          # QoreSign-signed recipient cards
npx tsx src/keys.ts window 1200 80 unscoped && (cd ../contracts && forge build) && npx tsx src/deploy.ts
npx tsx src/keys.ts close                     # contract creation is the one EVM transaction: close the window after
npx tsx src/cli.ts loop 345                   # relay, book, rebalance, NAV, queue, compliance, data room
npx tsx src/gastank.ts link                   # the treasury links the keeper's gas tank (spending rule)
npx tsx src/e2e.ts                            # on-chain end to end, ending with the post-quantum-only checks
npx tsx src/pq-audit.ts                       # every transaction hybrid-verified, no window, ECDSA-only refused
npx tsx src/bridge-check.ts                   # bridge messages rebuilt from calldata == their MessageSent logs
(cd ../web && node e2e/browser.mjs)           # browser end to end with the QoreX test double (9 checks)
```

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): contracts, keeper, app, and why each piece is where it is
- [docs/PQ_ETHEREUM.md](docs/PQ_ETHEREUM.md): making the Ethereum leg quantum resilient, every option, measured
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md): what each key can do, what a quantum adversary can and cannot do
- [docs/E2E.md](docs/E2E.md): the end-to-end runs, on chain and in the browser
- [docs/cbom](docs/cbom): QoreScan CBOM, DORA mapping, crypto-agility template
- [AI_USAGE.md](AI_USAGE.md)

## Credits

Written during the fest. Reused, with credit:
[Agama on Whitechain](https://github.com/agamafinance/agama-whitechain) (same team: the vault accounting, the CCTP V2
codec, the Ethereum leg, the web app's look) and
an earlier QoreChain build (same team, MIT: `PqcAuth`, the mock
precompiles, the hand-encoded protobuf, the QoreX provider and the fest-token conversions). QoreChain's kits:
QoreChain SDK, QoreSeal, QoreSign, qorechain-pqc, QoreX integrations, Asset Kit (Apache-2.0), QoreScan.
[ZKNox ETHDILITHIUM](https://github.com/ZKNoxHQ/ETHDILITHIUM) (MIT, the Solidity ML-DSA verifier), OpenZeppelin Contracts 5.4, forge-std, viem, Next.js.

Licence: Apache-2.0.
