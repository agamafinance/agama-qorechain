# PqAccount battery, 2026-11-20T17:52Z

`keeper/src/pq-battery.ts` on qorechain-diana, the GitHub keeper as compliance officer. Four new QoreX-style accounts that hold an ML-DSA-87 key and nothing else; every action a message signed as QoreX signs it, verified on chain by the lender's PqAccount with pqcVerify.

    1. four new QoreX accounts: an ML-DSA-87 key each, nothing else
    2. test USDC, encryption key and sealed application: three signed messages each
    PASS  A: PqAccount created by its first message, application filed  3517 bytes sealed, 0x1b4d582371…
    PASS  B: PqAccount created by its first message, application filed  3525 bytes sealed, 0xd81834435c…
    PASS  C: PqAccount created by its first message, application filed  3509 bytes sealed, 0x96c22fba96…
    PASS  D: PqAccount created by its first message, application filed  3515 bytes sealed, 0x03b638d6a8…
    3. the running keeper decides (ML-DSA-87 signed, checked on chain)
    PASS  A: approved  Approved
    PASS  A: opens its own sealed letter; the officer verified the PqAccount filing  Professional
    PASS  B: approved  Approved
    PASS  B: opens its own sealed letter; the officer verified the PqAccount filing  Institutional
    PASS  C: rejected  Rejected
    PASS  C: opens its own sealed letter; the officer verified the PqAccount filing  The note is reserved to professional, institutional and accredited investors.
    PASS  D: rejected  Rejected
    PASS  D: opens its own sealed letter; the officer verified the PqAccount filing  The note cannot be offered to residents of US.
    4. money in and out, one signed message per action
    PASS  A: deposit, approval and deposit in one message  2956.200845 agUSD
    PASS  A: instant withdrawal from the buffer
    PASS  A: queued withdrawal recorded, priced at the request  request #25
    PASS  A: the queue is settled from the buffer, paid to the PqAccount  next to settle #26
    PASS  B: deposit, approval and deposit in one message  2956.200693 agUSD
    PASS  B: full withdrawal
    PASS  C: a deposit by a rejected lender is refused
    PASS  D: a deposit by a rejected lender is refused
    PASS  agUSD cannot be sent to a rejected lender's PqAccount
    PASS  a PqAccount cannot be told to call anything but Agama's contracts
    5. what the lenders never had to do
    PASS  A: no EVM window, no grant, no QOR spent  1.01 QOR
    PASS  B: no EVM window, no grant, no QOR spent  1.01 QOR
    PASS  C: no EVM window, no grant, no QOR spent  1.01 QOR
    PASS  D: no EVM window, no grant, no QOR spent  1.01 QOR
    26/26 PqAccount battery checks passed
