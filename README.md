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
- Every lender action is a QoreX transaction, **hybrid-signed secp256k1 + ML-DSA-87**.

Built for **Build Before Q-Day**, the QoreChain Developer Fest, on `qorechain-diana`, during the fest.
Category: **Encrypted Apps**.

> Live on the QoreChain and Ethereum Sepolia testnets. Tests: 170 Foundry, 23 on-chain e2e checks, 9 browser e2e
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
| Every admin power (config, roles, receivers, attester, officer, manager) | admin's ML-DSA-87 signature | `pqcVerify`; no function checks `msg.sender` for admin powers |
| Keeper's own EVM transactions | EVM window **scoped** to Agama's six contracts | the chain's EVM lane admission |
| Pause | guardian (classical key) | can only stop new money; never costs a holder anything |

Every ML-DSA-87 signature the keeper produces is first verified locally with **qorechain-pqc** against the key the
chain holds for that role, so a mismatched key fails for free instead of as a reverted transaction.

## Kits and network functions

**Kits:** QoreChain SDK (TypeScript), QoreSeal (TypeScript), QoreSign (TypeScript), qorechain-pqc (TypeScript),
QoreX integrations (`@qorechain/qorex-types`, `@qorechain/qorex-wallet-mock`), Asset Kit (Solidity:
`QoreChainHybridHolderGuard`, `IHolderEligibility`, `IERC3643ComplianceModule`), QoreScan (CBOM, DORA mapping, agility template in `docs/cbom`).

**Network functions:** ML-DSA-87 hybrid transactions; PQC key registration with proof of possession; EVM window,
scoped; PQC signature verification in Solidity (`pqcVerify`); PQC key status in Solidity (`pqcKeyStatus`); QoreSeal
and the encryption key registry (`MsgRegisterKEMKey`); Fest test tokens (fUSD, via `MsgConvertCoin` and the
`FestUsdOnRamp`); cross-VM calls (native to EVM, `MsgCrossVMCall`); Asset Kit; QoreScan.

## Contracts

`contracts/` · Solidity 0.8.28, Foundry, OpenZeppelin 5.4, Asset Kit. **170 tests** (unit, fuzz, 6 invariants).

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
| `cctp/EcdsaAttestedMessenger` | Ethereum | the same, secp256k1 attestations (Ethereum cannot verify ML-DSA-87 at a sane cost) |
| `l1/AgamaL1Receiver`, `l1/AbfAssetIssuer` | Ethereum | agUSD's position and the simulated ABF issuer (allowlisted ERC-4626 note) |

### Addresses (v2)

QoreChain `qorechain-diana`, EVM chain id 9800:

| | |
|---|---|
| agUSD vault | `0x0ed07a6af9e1e78c0166a3c02133ac994268be5d` |
| AccessRegistry | `0x032492a0dc1159d781025a82a3999faf2d360441` |
| DataRoom | `0x1c39681a25f1c9dca3f3a6621f5abbb629f574ef` |
| PqAttestedMessenger | `0x0afb58ce8aa5be74251e61e7b9404529d6087013` |
| CrossChainAllocator | `0x7e913de8003c0ad626fd2c44d56efea13c28fb17` |
| QoreChainHybridHolderGuard (Asset Kit) | `0xa112c61bff6439b11ea96ffc20cd121db3f0739a` |
| AgamaComplianceModule | `0xebcb8d74fb8354c55dc750a7feaeed46d123b391` |
| FestUsdOnRamp | `0x8cecfcd4ccb825d877baee30c52153bc6828b712` |
| Mock USDC | `0xa57f460cd0b27612e870963c20b9a27d11ddc608` |

Ethereum Sepolia: receiver `0xe1badae5cfeced419e96a5225570343da0a005c8`, issuer
`0xc0f1d29f7778a663f3502afe9acb467d065d993f`, messenger `0x7f8fa0b60361ac79024bf97a91f80ce2f662c17c`, mock USDC
`0x1c8669b4e26a642d83748984d19dd5149af8c42b`. Everything is in `deployments/`.

### Testnet accounts (`qor1`)

| Role | Address | Keys |
|---|---|---|
| Operator, admin, guardian | `qor1qvc7jve4se89maha3sn2cedn589dvny6kskgly` | ML-DSA-87 (registered, PoP), scoped EVM window |
| NAV reporter | `qor1gp6jjx2u7h6vrcv2h4rtsxp0al8h4mv37sn064` | ML-DSA-87 only signs |
| Compliance officer, data room manager | `qor17q0jps4cvvg2x6xm3d2d44pev4shh4lx3x50re` | ML-DSA-87 + ML-KEM-1024 (KEM registry) |
| Bridge attester | `qor122d73j03vxdzvwlpvzdze30s0gejn2q8g252h7` | ML-DSA-87 towards QoreChain, secp256k1 towards Ethereum |
| Auditor (view key) | `qor1z0y4zrt2pkxmrgzzvh2cws5azlvf66zckvkx9w` | ML-KEM-1024 (KEM registry) |

## Run it

```bash
git clone --recursive https://github.com/agamafinance/agama-qorechain && cd agama-qorechain

cd contracts && forge test && cd ..            # 170 tests, mock precompiles locally

cd web && pnpm install && pnpm build && pnpm start   # http://localhost:3034/qorechain
```

Install QoreX, take QOR (and fUSD) from the [QoreChain faucet](https://dashboard.qorechain.io/faucet), then
**Access** (key, sealed application, decision), **Faucet** (mock USDC, or swap your fUSD), **Earn**, **Data room**.

Operating a deployment (testnet mnemonics only, never committed: `~/.config/qorechain/testnet.mnemonic` for the
roles, `~/.config/qorechain/agama-funder.mnemonic` for the funding QoreX account):

```bash
cd keeper && npm install
npx tsx src/keys.ts status                    # roles: QOR, ML-DSA-87, ML-KEM-1024, EVM window
npx tsx src/fund.ts 55 3 8 3 3                # QOR to operator, reporter, compliance, attester, auditor
npx tsx src/keys.ts register all              # ML-DSA-87 keys with proof of possession
npx tsx src/keys.ts kem all                   # officers' ML-KEM-1024 keys in the KEM registry
npx tsx src/cards.ts                          # QoreSign-signed recipient cards
npx tsx src/keys.ts window 1200 80 unscoped && (cd ../contracts && forge build) && npx tsx src/deploy.ts
npx tsx src/keys.ts window                    # the keeper's window, scoped to Agama's contracts
npx tsx src/cli.ts loop 345                   # relay, book, rebalance, NAV, queue, compliance, data room
npx tsx src/e2e.ts                            # on-chain end to end (23 checks)
(cd ../web && node e2e/browser.mjs)           # browser end to end with the QoreX test double (9 checks)
```

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): contracts, keeper, app, and why each piece is where it is
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
OpenZeppelin Contracts 5.4, forge-std, viem, Next.js.

Licence: Apache-2.0.
