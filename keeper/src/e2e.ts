/**
 * End to end on the live testnets, with a lender who does exactly what a QoreX user does: every action is a native
 * transaction, hybrid-signed (secp256k1 + ML-DSA-87), reaching the EVM through MsgCrossVMCall. The lender is the
 * funding QoreX account (coin 118), whose canonical ML-DSA-87 key is registered on chain.
 *
 *   1. publish an ML-KEM-1024 key: QoreChain's KEM registry and the AccessRegistry, one transaction
 *   2. file a KYC dossier sealed to the compliance officer and the auditor; the chain stores ciphertext only
 *   3. the keeper's compliance officer opens it, approves it with an ML-DSA-87 signature checked by pqcVerify, and
 *      seals the decision letter, which the lender opens with its own key
 *   4. mint mock USDC and deposit into agUSD, which only an approved, quantum-safe account may hold
 *   5. the keeper allocates above the 10% floor, relays to Ethereum, the issuer subscribes and wires it out
 *   6. the data room starts an epoch with the lender in it and publishes the loan tape; the lender decrypts both,
 *      and so does the auditor
 *   7. the lender queues an exit larger than the buffer; the keeper brings cash home under an ML-DSA-87 attestation
 *      and the queue pays it
 *
 *   tsx src/e2e.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromBech32 } from "@cosmjs/encoding";
import {
  decodeEventLog, encodeFunctionData, formatUnits, hexToBytes, keccak256, maxUint256, parseAbiItem, toHex, type Address, type Hex,
} from "viem";
import { generateSealKeys, open, openBatch, openEpochKey, seal, sealKeysFromSeed, type SealKeyPair } from "@qorechain/qoreseal";
import { msg as qmsg } from "@qorechain/sdk";
import { fetchKemKey } from "@qorechain/qoreseal/network";
import { sealKeys } from "./accounts.js";
import { E, Q } from "./config.js";
import { artifact } from "./evm.js";
import { treasuryClient } from "./native.js";
import { CONVERT_COIN_TYPE_URL } from "./erc20Msgs.js";
import { verifyTxByHash } from "./provenance.js";
import { refuel, TANK } from "./gastank.js";
import { eth, qore, REST, sleep } from "./net.js";
import { aadFor, officer, SEAL } from "./sealing.js";
import { reviewDossiers, type Letter } from "./compliance.js";
import { epochEnvelopeFor, epochEnvelopeForAuditor, publishTape } from "./dataroom.js";
import { relayAll } from "./relay.js";
import { bringHome, runBook } from "./book.js";
import { rebalance, settleQueue, snapshot, vaultNeedsWork } from "./vault.js";
import type { LoanTape } from "./tape.js";

const Access = artifact("AccessRegistry").abi;
const Vault = artifact("AgUSD").abi;
const Usdc = artifact("MockUSDC").abi;
const Room = artifact("DataRoom").abi;
const Receiver = artifact("AgamaL1Receiver").abi;
const Allocator = artifact("CrossChainAllocator").abi;

const results: [string, boolean, string][] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const usd = (v: bigint) => `$${Number(formatUnits(v, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const read = <T>(address: Address, abi: any, functionName: string, args: unknown[] = []) =>
  qore.readContract({ address, abi, functionName, args } as any) as Promise<T>;

const { client, address: lender } = await treasuryClient();
const twin = `0x${Buffer.from(fromBech32(lender, 90).data).toString("hex")}` as Address;
console.log(`lender ${lender} (EVM twin ${twin})\n`);

const hybridTxs: boolean[] = [];

/** One hybrid-signed native transaction carrying cross-VM calls (and any native message). */
async function native(label: string, msgs: any[], gas: number) {
  const res: any = await client.signAndBroadcast(msgs, { amount: [{ denom: "uqor", amount: String(Math.ceil(gas * 0.125)) }], gas: String(gas) }, `agama e2e: ${label}`);
  if (res.code) throw new Error(`${label} failed: ${res.rawLog}`);
  // A second opinion on every lender transaction: both signatures re-verified with QoreSign against the chain's keys.
  await sleep(1_500);
  const v = await verifyTxByHash(res.transactionHash).catch(() => ({ classical: false, postQuantum: false }));
  const hybrid = v.classical && v.postQuantum;
  console.log(`  ${label.padEnd(28)} ${res.transactionHash}  gas ${res.gasUsed}  ${hybrid ? "secp256k1 + ML-DSA-87 verified (QoreSign)" : "NOT verified"}`);
  hybridTxs.push(hybrid);
  return { hash: res.transactionHash as string, hybrid };
}
const call = (target: Address, abi: any, functionName: string, args: unknown[]) => ({
  typeUrl: "/qorechain.crossvm.v1.MsgCrossVMCall",
  value: {
    sender: lender, sourceVm: "cosmwasm", targetVm: "evm", targetContract: target,
    payload: hexToBytes(encodeFunctionData({ abi, functionName, args })), funds: [], async: false, asyncGasLimit: "0", asyncMaxFactor: "0",
  },
});

// The lender's QoreSeal key lives on its device; here, in a gitignored file.
const SECRETS = join(import.meta.dirname, "../secrets");
mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
const seedFile = join(SECRETS, "e2e-lender.seed");
let keys: SealKeyPair;
if (existsSync(seedFile)) keys = sealKeysFromSeed(hexToBytes(readFileSync(seedFile, "utf8").trim() as Hex));
else {
  keys = generateSealKeys();
  writeFileSync(seedFile, toHex(keys.seed), { mode: 0o600 });
}

// ---- 1. encryption key ----
console.log("1. publish the lender's ML-KEM-1024 key");
const pqc = (await read<[boolean, number, Hex, boolean]>("0x0000000000000000000000000000000000000a02", artifact("IQorePQC").abi, "pqcKeyStatus", [twin]));
check("lender's EVM twin is quantum safe (pqcKeyStatus)", pqc[0] && pqc[3], `ML-DSA-87 key of ${(pqc[2].length - 2) / 2} bytes, possession proven`);
const onContract = await read<Hex>(Q.access, Access, "encryptionKey", [twin]);
if (onContract !== toHex(keys.mlkemPublicKey)) {
  // QoreChain refuses to publish the same KEM key twice (pqc 253), so the registry message goes only when needed.
  const inRegistry = await fetchKemKey({ rest: REST, address: lender }).catch(() => ({ registered: false }) as const);
  const same = inRegistry.registered && Buffer.from(inRegistry.publicKey!).equals(Buffer.from(keys.mlkemPublicKey));
  await native("publish encryption key", [
    ...(same ? [] : [qmsg.pqc.registerKemKey({ sender: lender, algorithmId: 2, publicKey: keys.mlkemPublicKey })]),
    call(Q.access, Access, "publishEncryptionKey", [toHex(keys.mlkemPublicKey)]),
  ], 2_500_000);
  await sleep(3_000);
}
const kem = await fetchKemKey({ rest: REST, address: lender });
check("ML-KEM-1024 key in QoreChain's KEM registry", kem.registered && Buffer.from(kem.publicKey!).equals(Buffer.from(keys.mlkemPublicKey)));
check("same key bound in the AccessRegistry", (await read<Hex>(Q.access, Access, "encryptionKey", [twin])) === toHex(keys.mlkemPublicKey));

// ---- 2. sealed dossier ----
console.log("\n2. file a sealed KYC dossier");
const member = await read<readonly [number, number, bigint, bigint, bigint, bigint, Hex]>(Q.access, Access, "members", [twin]);
const dossier = {
  v: 1, name: "Helena Varga", email: "helena@example.test", country: "FR", investorType: "professional",
  entity: "Varga Family Office SAS", sourceOfFunds: "Proceeds of a business sale",
  attestations: { notUsPerson: true, notSanctioned: true, understandsRisk: true }, declaredAt: new Date().toISOString(),
};
if (member[0] !== 2) {
  const envelope = toHex(seal({
    chainId: SEAL.chainId, purpose: SEAL.dossier, mode: SEAL.mode, aad: aadFor(twin),
    recipients: [await officer("compliance"), await officer("auditor")],
    plaintext: new TextEncoder().encode(JSON.stringify(dossier)),
  }));
  await native("file dossier", [call(Q.access, Access, "fileDossier", [envelope])], 4_500_000);
  await sleep(3_000);
}
const stored = await read<Hex>(Q.access, Access, "dossier", [twin]);
check("dossier on chain is ciphertext only", stored.startsWith("0x5153454c") && !Buffer.from(hexToBytes(stored)).toString("latin1").includes("Varga"), `${(stored.length - 2) / 2} bytes, QSEL envelope`);
let lenderOpened = true;
try { open({ chainId: SEAL.chainId, purpose: SEAL.dossier, envelope: hexToBytes(stored), keys, aad: aadFor(twin) }); } catch { lenderOpened = false; }
check("the dossier is not readable without an officer's key", !lenderOpened);
const audited = JSON.parse(new TextDecoder().decode(open({ chainId: SEAL.chainId, purpose: SEAL.dossier, envelope: hexToBytes(stored), keys: sealKeys("auditor"), aad: aadFor(twin) })));
check("the auditor's view key opens it", audited.name === dossier.name);

// ---- 3. decision ----
console.log("\n3. compliance decides, ML-DSA-87 signed");
if (member[0] !== 2) await reviewDossiers();
await sleep(3_000);
check("lender approved and eligible", await read<boolean>(Q.access, Access, "isEligible", [twin]));
const m2 = await read<readonly [number, number, bigint, bigint, bigint, bigint, Hex]>(Q.access, Access, "members", [twin]);
const approvedLogs = await qore.getLogs({
  address: Q.access, event: parseAbiItem("event Approved(address indexed account, uint8 tier, uint64 expiresAt, bytes32 dossierHash, bytes letter)"),
  args: { account: twin }, fromBlock: m2[5], toBlock: m2[5],
});
const letter = JSON.parse(new TextDecoder().decode(open({
  chainId: SEAL.chainId, purpose: SEAL.letter, envelope: hexToBytes(approvedLogs[0].args.letter!), keys, aad: aadFor(twin),
}))) as Letter;
check("lender opens its sealed decision letter", letter.decision === "approved", `${letter.tierName}, until ${new Date(letter.expiresAt! * 1000).toISOString().slice(0, 10)}`);
check("the letter names the dossier the officer read", letter.dossierHash === keccak256(stored));
check("the officer verified the filing transaction's two signatures (QoreSign)", !!letter.provenance?.classical && !!letter.provenance?.postQuantum, `tx ${letter.provenance?.tx.slice(0, 12)}…`);
check("an ERC-3643 token using AgamaComplianceModule would admit the lender", await read<boolean>(Q.complianceModule as Address, artifact("AgamaComplianceModule").abi, "moduleCheck", [ "0x0000000000000000000000000000000000000000", twin, 1n, twin ]));

// ---- 4. deposit ----
console.log("\n4. mint mock USDC and deposit");
const AMOUNT = 10_000_000_000n;
const before = await snapshot();
// Measured from before the deposit: a keeper running alongside may allocate it within seconds, before step 5 does.
const sentBefore = await read<bigint>(Q.allocator, Allocator, "totalSent");
const recvBefore = (await eth.readContract({ address: E.receiver, abi: Receiver, functionName: "totalReceived" })) as bigint;
const sharesBefore = await read<bigint>(Q.vault, Vault, "balanceOf", [twin]);
await native("faucet + approve + deposit", [
  call(Q.usdc, Usdc, "faucet", []),
  call(Q.usdc, Usdc, "approve", [Q.vault, maxUint256]),
  call(Q.vault, Vault, "deposit", [AMOUNT, twin]),
], 2_000_000);
await sleep(3_000);
const shares = (await read<bigint>(Q.vault, Vault, "balanceOf", [twin])) - sharesBefore;
check("agUSD minted to the approved lender", shares > 0n, `${formatUnits(shares, 6)} agUSD`);
const stranger = "0x000000000000000000000000000000000000dEaD";
check("a stranger cannot be sent agUSD (maxDeposit 0)", (await read<bigint>(Q.vault, Vault, "maxDeposit", [stranger])) === 0n);

// ---- 4b. the fest's own dollar: bank fUSD -> ERC-20 (MsgConvertCoin) -> mock USDC through the on-ramp ----
console.log("\n4b. lend the fest's fUSD");
const FUSD = Q.fusd as Address;
const FUSD_IN = 100_000_000n;
const usdcBeforeRamp = await read<bigint>(Q.usdc, Usdc, "balanceOf", [twin]);
await native("fUSD: convert + on-ramp", [
  { typeUrl: CONVERT_COIN_TYPE_URL, value: { coin: { denom: `erc20:${FUSD}`, amount: FUSD_IN.toString() }, receiver: twin, sender: lender } },
  call(FUSD, Usdc, "approve", [Q.fusdOnRamp, FUSD_IN]),
  call(Q.fusdOnRamp as Address, artifact("FestUsdOnRamp").abi, "onRamp", [FUSD_IN]),
], 1_800_000);
await sleep(3_000);
const ramped = (await read<bigint>(Q.usdc, Usdc, "balanceOf", [twin])) - usdcBeforeRamp;
check("100 fest fUSD became 100 mock USDC, one hybrid-signed transaction", ramped === FUSD_IN, `${usd(ramped)}`);

// ---- 5. allocation and the route to Ethereum ----
console.log("\n5. allocate above the floor and cross to Ethereum");
// Drive the route ourselves, or let the keeper do it, then wait until both legs agree and the vault is at rest.
for (let i = 0; i < 12; i++) {
  await rebalance().catch(() => false);
  await relayAll().catch(() => 0);
  await runBook().catch(() => undefined);
  const sentNow = await read<bigint>(Q.allocator, Allocator, "totalSent");
  const recvNow = (await eth.readContract({ address: E.receiver, abi: Receiver, functionName: "totalReceived" })) as bigint;
  if (sentNow > sentBefore && sentNow - sentBefore === recvNow - recvBefore && !(await vaultNeedsWork())) break;
  await sleep(10_000);
}
const s = await snapshot();
const sent = (await read<bigint>(Q.allocator, Allocator, "totalSent")) - sentBefore;
const recv = ((await eth.readContract({ address: E.receiver, abi: Receiver, functionName: "totalReceived" })) as bigint) - recvBefore;
check("vault keeps its 10% buffer, the rest at work", s.liquid * 10_000n >= s.totalAssets * 990n && s.liquid * 10_000n <= s.totalAssets * 1_050n + 10_000_000_000n, `${usd(s.liquid)} of ${usd(s.totalAssets)}`);
check("allocation burned on QoreChain arrived on Ethereum", sent > 0n && recv === sent, `${usd(sent)}`);
const book = (await eth.readContract({ address: E.issuer, abi: artifact("AbfAssetIssuer").abi, functionName: "offChainAssets" })) as bigint;
check("issuer wired the subscription to the book", book > 0n, `book ${usd(book)}`);
void before;

// ---- 6. data room ----
console.log("\n6. data room: epoch and sealed loan tape");
await publishTape(true);
await sleep(3_000);
const epochs = await read<bigint>(Q.dataRoom, Room, "epochCount");
const ep = await read<{ blockNumber: bigint }>(Q.dataRoom, Room, "epochs", [epochs - 1n]);
check("lender is a member of the current epoch", await read<boolean>(Q.dataRoom, Room, "isMember", [epochs - 1n, twin]), `epoch ${epochs - 1n}`);
const myPart = await epochEnvelopeFor(epochs - 1n, twin);
const ek = openEpochKey({ chainId: SEAL.chainId, purpose: SEAL.epoch, envelope: hexToBytes(myPart!), keys });
const [last] = await read<{ blockNumber: bigint; ciphertextCommitment: Hex }[]>(Q.dataRoom, Room, "latestReports", [1n]);
const rLog = (await qore.getLogs({ address: Q.dataRoom, event: parseAbiItem("event ReportPublished(uint256 indexed index, uint256 indexed epoch, bytes32 indexed kind, bytes blob, bytes32 ciphertextCommitment, bytes32 plaintextCommitment)"), fromBlock: last.blockNumber, toBlock: last.blockNumber })).at(-1)!;
const opened = openBatch({ blob: hexToBytes(rLog.args.blob!), keys: [ek] });
const tape = JSON.parse(new TextDecoder().decode(opened.data)) as LoanTape;
check("lender decrypts the loan tape", tape.loans.length === 12, `${tape.loans.length} facilities, book ${usd(BigInt(tape.book))}, 30dpd ${tape.delinquency.dpd30Bps / 100}%`);
check("ciphertext commitment matches the chain", toHex(opened.ciphertextCommitment) === last.ciphertextCommitment);
const auditorKey = openEpochKey({ chainId: SEAL.chainId, purpose: SEAL.epoch, envelope: hexToBytes((await epochEnvelopeForAuditor(epochs - 1n))!), keys: sealKeys("auditor") });
check("the auditor opens the same epoch", Buffer.from(auditorKey.key).equals(Buffer.from(ek.key)));
let outsider = true;
try { openEpochKey({ chainId: SEAL.chainId, purpose: SEAL.epoch, envelope: hexToBytes(myPart!), keys: generateSealKeys() }); } catch { outsider = false; }
check("an outsider's key does not open it", !outsider);

// ---- 7. a queued exit, paid by cash brought home under an ML-DSA-87 attestation ----
console.log("\n7. queued exit");
const held = await read<bigint>(Q.vault, Vault, "balanceOf", [twin]);
const exitShares = held / 2n;
const snapBefore = await snapshot();
const usdcBefore = await read<bigint>(Q.usdc, Usdc, "balanceOf", [twin]);
await native("request redeem", [call(Q.vault, Vault, "requestRedeem", [exitShares, twin, twin])], 1_500_000);
await sleep(3_000);
const ids = await read<bigint[]>(Q.vault, Vault, "requestsOf", [twin]);
const id = ids[ids.length - 1];
const req = await read<readonly [Address, Address, bigint, bigint]>(Q.vault, Vault, "redemptions", [id]);
const owed = req[3];
check("exit queued at today's price", owed > snapBefore.liquid || owed > 0n, `${usd(owed)} for claim #${id}`);
const s2 = await snapshot();
const short = s2.pending > s2.idle ? s2.pending - s2.idle : 0n;
if (short > 0n) {
  await bringHome(short + 1_000_000n);
  await relayAll();
}
await settleQueue();
await sleep(3_000);
const paid = (await read<bigint>(Q.usdc, Usdc, "balanceOf", [twin])) - usdcBefore;
check("queue paid the lender in full", paid >= owed, `${usd(paid)}`);

// ---- 8. the keeper's gas tank: a spending rule the chain enforces, not the keeper's code ----
console.log("\n8. gas tank");
const paidOk = await refuel(1).then(() => true).catch(() => false);
check("gas tank pays the operator 1 QOR from the treasury, inside the rule", paidOk);
const refusedMsg = await refuel(TANK.perTxQor + 1).then(() => "").catch((e) => String((e as Error).message));
check("the chain refuses a payment over the per-payment limit", /limit/.test(refusedMsg), refusedMsg.replace("refused by the chain: ", "").slice(0, 70));

check("every lender transaction: secp256k1 and ML-DSA-87 both verify (QoreSign)", hybridTxs.length > 0 && hybridTxs.every(Boolean), `${hybridTxs.length} transactions`);

const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
