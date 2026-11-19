# Threat model

Two adversaries. The **classical** one steals keys, runs nodes, relays, front-runs, reads everything public. The
**quantum** one can do all that and, from Q-Day on, derive any secp256k1 (or Ed25519, RSA, ECDH) private key from
its public key, and decrypt anything that was encrypted to a classical key and recorded before.

Private credit is the asset class where "harvest now, decrypt later" hurts most: borrower files and investor KYC
must stay confidential for decades, not until the next cryptographic break. That is why nothing confidential in
Agama on QoreChain is ever encrypted to a classical key alone, and why no key that can move money is classical.

## Keys and what each can do

| Key | Type | Can | Cannot |
|---|---|---|---|
| Admin | ML-DSA-87 (QoreChain account, registered with proof of possession) | change vault config, roles, the bridge receiver and attester, the compliance officer, the data room manager | act without its PQ signature; no admin function checks `msg.sender` |
| NAV reporter | ML-DSA-87, never sends a transaction | mark the deployed capital, within ±5% per report and once per 10 min at most | conjure value from nothing (with nothing deployed, the only valid report is 0) |
| Compliance officer | ML-DSA-87 + ML-KEM-1024 | read dossiers sealed to it; approve, reject, revoke | approve a dossier other than the one it read (the hash is signed); make a non-quantum-safe account eligible (the Asset Kit guard still decides) |
| Data room manager (same account) | ML-DSA-87 | start epochs, publish tapes | include a member the registry does not approve right now |
| Auditor | ML-KEM-1024 view key | read every dossier, letter, epoch and tape | change anything |
| Bridge attester | ML-DSA-87 towards QoreChain, secp256k1 towards Ethereum | mint on QoreChain only what Ethereum burned towards the allocator; mint on Ethereum only what QoreChain burned towards the receiver | mint on QoreChain with its secp256k1 key alone |
| Operator | secp256k1 + ML-DSA-87, EVM window scoped to Agama's 6 contracts | start allocations (to the fixed receiver, above the reserve floor), relay messages and signed actions | choose where money goes, change anything, call any contract outside the scope |
| Gas tank key | ed25519 authenticator on the treasury | send the treasury's QOR, 5 per payment, 15 a day, until expiry | anything else; the limits are the chain's, revocable by the treasury. Ed25519 is classical: a quantum adversary could spend this allowance, and only it |
| Guardian | secp256k1 (classical) | pause deposits and exits | anything that costs a holder; unpausing needs the admin's PQ signature |
| Lender | QoreX: secp256k1 + ML-DSA-87 on every transaction, plus a QoreSeal key held in the browser | deposit, exit, transfer to other approved lenders, read its letter and the data room | hold agUSD unless approved and still a hybrid holder |

## What a quantum adversary gets

| Asset | Exposure |
|---|---|
| Lender transactions | Every one carries an ML-DSA-87 layer the chain verifies (`required` mode). A recovered secp256k1 key alone cannot sign for a lender. |
| Vault governance, NAV, KYC decisions, data room | ML-DSA-87 only. Nothing. |
| Money arriving on QoreChain | ML-DSA-87 attested. Nothing. |
| KYC dossiers | Sealed hybrid: ML-KEM-1024 and X25519 combined through SHA3-256. Harvested ciphertext stays safe as long as ML-KEM-1024 holds. |
| Decision letters, epoch keys | ML-KEM-1024 alone (`mlkem` mode, chosen explicitly). Same. |
| Loan tapes | AES-256-GCM under a 32-byte epoch key that is only ever sealed with ML-KEM-1024. Same. |
| **The Ethereum leg** | **The weak point, by necessity.** Ethereum cannot verify ML-DSA-87 at a sane gas cost, so `EcdsaAttestedMessenger` checks a secp256k1 attestation, and the issuer and receiver are governed by classical keys. A quantum adversary who recovered the attester's secp256k1 key could forge a message *into* Ethereum, i.e. mint mock USDC to the receiver. QoreScan flags exactly this (`docs/cbom/dora.md`, ECDSA secp256k1 at `cctp/EcdsaAttestedMessenger.sol`). It cannot move money *out of* QoreChain or into the vault. Mitigations on the path to mainnet: Circle CCTP itself for the Ethereum leg, a ZK verifier of ML-DSA on Ethereum, or settling the book on QoreChain. |
| Public metadata | Who applied, when, envelope sizes, outcomes, amounts, balances. QoreSeal protects content, not metadata; this is stated in the app. |

## Classical attacks considered

- **Replayed signatures.** Every ML-DSA-87 authorisation is bound to chain id, contract, action, signer, a per-signer
  nonce and a deadline (`PqcSigned.pqcMessage`). Bridge attestations are bound to the messenger and chain, and the
  CCTP nonce is marked used.
- **A stale or swapped dossier.** The officer signs the dossier's hash; refiling puts the account back to Pending and
  makes the old signature fail (`StaleDossier`). The officer also verifies, with QoreSign, both signatures of the
  transaction that filed it, so the decision never rests on trusting a node.
- **An envelope lifted from one account to another.** Dossiers and letters bind the lender's address as AEAD
  associated data.
- **A forged recipient card.** Cards are verified against both on-chain keys; a forged card can at worst reduce an
  envelope to ML-KEM-1024 strength, never redirect it.
- **NAV manipulation and sandwiching.** Max move per report, minimum interval, profit vests over 6 hours, losses eat
  unvested profit first.
- **A run on the vault.** Exits above the 10% buffer queue FIFO at the price of the request; the keeper refills the
  buffer under half the floor; anyone can settle the queue.
- **A revoked or expired lender.** Burns are never gated: it can always redeem or queue an exit; it cannot transfer.
- **Precompile absent (e.g. mainnet today).** The Asset Kit guard fails closed: nobody is eligible.
- **A keeper or operator key stolen.** It can only start allocations to the fixed receiver above the floor, and
  relay. Its EVM window is scoped to Agama's contracts and bounded in blocks, transactions and value.
- **A mismatched or rotated PQ key.** Every signature the keeper produces is checked locally with qorechain-pqc against
  the key the chain holds before it is sent.

## Out of scope on the testnet

The ABF issuer is simulated (the partner runs no testnet); custody is a key; the compliance policy is automated and
reads declarations rather than documents; the mock USDC and its faucet stand in for USDC, which QoreChain does not
have yet.
