# AI usage

Agama on QoreChain was built with **Claude Code** (Anthropic), driven by the team in French over one long session.

What the AI did, under review:
- read the fest's rules and kits and QoreChain's docs, SDKs and the Asset Kit sources, and proposed the architecture
  (Encrypted Apps track: sealed KYC, encrypted data room, ML-DSA-87 governance and bridge attestations)
- wrote the contracts, the keeper, the web app and the documentation, committed step by step
- wrote the test suites (a sub-agent wrote most of the Foundry suite; its invariant run found a real underflow in the
  vault's fee accounting when the queue is underwater, fixed in `AgUSD._recognizeGain`, and the same bug in the
  Whitechain deployment it was ported from)
- ran the key ceremony, the deployments and every end-to-end run on the live testnets, and read the results
- generated the CBOM with QoreScan and wrote the threat model from what it flagged

What stayed with the team: the product (one yield-bearing token, a permissioned vault, the Whitechain-style route to
an Ethereum issuer), every decision about funds and keys (testnet mnemonics only, kept outside the repository), and
the review of what was shipped. A dependency the team's npm guard flagged as too recent (`@qorechain/qore-cli`) was
left out rather than forced in.
