/**
 * The battery: many lenders at once, every action a real hybrid-signed transaction on qorechain-diana, and the
 * production keeper (GitHub Actions) doing its job on the other side: compliance, data room, bridge, book, queue.
 * Nothing here plays the keeper, except the revocation, which is a compliance decision a person would take.
 *
 * Lenders are QoreX-style accounts (coin 118) of the funding mnemonic, indexes BATTERY_BASE (10) to +7. Eight profiles, six
 * eligible, two that compliance must refuse. Phases:
 *
 *   A  fund, register ML-DSA-87 keys, publish ML-KEM-1024 keys, file sealed dossiers, all in parallel
 *   B  the keeper decides; every lender opens its own sealed letter; the refused ones are refused for the right reason
 *   C  transactions that must fail, really sent: deposits and transfers to the refused, a malformed dossier,
 *      a short encryption key
 *   D  six deposits at once; one fUSD on-ramp; agUSD transfers between approved lenders
 *   E  the keeper allocates and bridges; both legs agree; the vault keeps its buffer
 *   F  the data room: a new epoch with all six; each decrypts the tape; the refused cannot
 *   G  three instant withdrawals and three queued exits at once; the keeper brings cash home; the queue pays FIFO,
 *      each exactly what it was promised
 *   H  revocation: the revoked lender cannot transfer but can still redeem; the next epoch leaves it out
 *   I  invariants, and every lender transaction re-verified with QoreSign
 *
 *   tsx src/battery.ts            writes docs/battery/<date>.md
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromBech32 } from "@cosmjs/encoding";
import {
  encodeAbiParameters, encodeFunctionData, formatUnits, hexToBytes, keccak256, maxUint256, parseAbiItem, toHex, type Address, type Hex,
} from "viem";
import { generateSealKeys, open, openBatch, openEpochKey, seal, type SealKeyPair } from "@qorechain/qoreseal";
import { msg as qmsg } from "@qorechain/sdk";
import { sealKeys, treasury } from "./accounts.js";
import { E, Q, send } from "./config.js";
import { artifact, pqAuthorize } from "./evm.js";
import { sendNative, treasuryClient } from "./native.js";
import { eth, qore, REST, sleep } from "./net.js";
import { aadFor, officer, SEAL } from "./sealing.js";
import { CONVERT_COIN_TYPE_URL } from "./erc20Msgs.js";
import { verifyTxByHash } from "./provenance.js";
import { decisionLetter, epochPart, reportBlob } from "./chain.js";
import { ROOT } from "./deployments.js";
import { epochEnvelopeFor, epochEnvelopeForAuditor } from "./dataroom.js";
import type { Letter } from "./compliance.js";
import type { LoanTape } from "./tape.js";

const Access = artifact("AccessRegistry").abi;
const Vault = artifact("AgUSD").abi;
const Usdc = artifact("MockUSDC").abi;
const Room = artifact("DataRoom").abi;
const Receiver = artifact("AgamaL1Receiver").abi;
const Allocator = artifact("CrossChainAllocator").abi;
const OnRamp = artifact("FestUsdOnRamp").abi;

// ---------------------------------------------------------------------------
// bookkeeping
// ---------------------------------------------------------------------------

const results: { phase: string; name: string; ok: boolean; detail: string }[] = [];
let phase = "";
function check(name: string, ok: boolean, detail = "") {
  results.push({ phase, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const findings: string[] = [];
const usd = (v: bigint) => `$${Number(formatUnits(v, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const read = <T,>(address: Address, abi: any, functionName: string, args: unknown[] = []) =>
  qore.readContract({ address, abi, functionName, args } as any) as Promise<T>;
const until = async (what: string, fn: () => Promise<boolean>, timeoutMs: number, every = 10_000) => {
  const start = Date.now();
  for (;;) {
    if (await fn().catch(() => false)) return Date.now() - start;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
};
let txCount = 0;
const hybridOk: boolean[] = [];

// ---------------------------------------------------------------------------
// lenders
// ---------------------------------------------------------------------------

type Profile = { name: string; country: string; investorType: string; eligible: boolean; deposit: bigint };
const PROFILES: Profile[] = [
  { name: "Aurelia Capital SAS", country: "FR", investorType: "professional", eligible: true, deposit: 1_000_000_000n },
  { name: "Brandt Pension Fund", country: "DE", investorType: "institutional", eligible: true, deposit: 2_500_000_000n },
  { name: "Clara Meier", country: "CH", investorType: "accredited-individual", eligible: true, deposit: 5_000_000_000n },
  { name: "Delta Family Office Pte", country: "SG", investorType: "professional", eligible: true, deposit: 7_500_000_000n },
  { name: "Emirates Credit Partners", country: "AE", investorType: "institutional", eligible: true, deposit: 12_000_000_000n },
  { name: "Fennel Asset Management BV", country: "NL", investorType: "professional", eligible: true, deposit: 20_000_000_000n },
  { name: "Gaston Petit", country: "FR", investorType: "retail", eligible: false, deposit: 0n },
  { name: "Harbor Ridge LLC", country: "US", investorType: "professional", eligible: false, deposit: 0n },
];

type Lender = Profile & {
  i: number; address: string; twin: Address; keys: SealKeyPair; client: any;
  shares?: bigint; letter?: Letter; claimId?: bigint; owed?: bigint;
};

async function native(l: Lender, label: string, msgs: any[], gas: number, expectFailure = false) {
  try {
    const res: any = await l.client.signAndBroadcast(msgs, { amount: [{ denom: "uqor", amount: String(Math.ceil(gas * 0.125)) }], gas: String(gas) }, `agama battery: ${label}`);
    txCount++;
    if (res.code) {
      if (expectFailure) return { hash: res.transactionHash as string, failed: true, log: String(res.rawLog ?? "") };
      throw new Error(`${label} failed: ${res.rawLog}`);
    }
    await sleep(1_500);
    const v = await verifyTxByHash(res.transactionHash).catch(() => ({ classical: false, postQuantum: false }));
    hybridOk.push(v.classical && v.postQuantum);
    return { hash: res.transactionHash as string, failed: false, log: "" };
  } catch (e) {
    if (expectFailure) return { hash: "", failed: true, log: String((e as Error).message) };
    throw e;
  }
}
const call = (l: Lender, target: Address, abi: any, functionName: string, args: unknown[]) => ({
  typeUrl: "/qorechain.crossvm.v1.MsgCrossVMCall",
  value: {
    sender: l.address, sourceVm: "cosmwasm", targetVm: "evm", targetContract: target,
    payload: hexToBytes(encodeFunctionData({ abi, functionName, args })), funds: [], async: false, asyncGasLimit: "0", asyncMaxFactor: "0",
  },
});

// ---------------------------------------------------------------------------
// A. onboarding, in parallel
// ---------------------------------------------------------------------------

phase = "A onboarding";
console.log(`\n== ${phase}`);
const startedAt = Date.now();
const lenders: Lender[] = await Promise.all(
  PROFILES.map(async (p, k) => {
    const i = Number(process.env.BATTERY_BASE ?? 10) + k;
    const t = await treasury(i);
    const twin = toHex(fromBech32(t.native.address, 90).data) as Address;
    return { ...p, i, address: t.native.address, twin, keys: generateSealKeys(), client: undefined } as Lender;
  }),
);

// QOR for each lender, one hybrid-signed transaction from the operator. fUSD for two, from the funding account.
const bal = async (a: string) => {
  const r = await (await fetch(`${REST}/cosmos/bank/v1beta1/balances/${a}/by_denom?denom=uqor`, { headers: { "user-agent": "curl/8.7.1" } })).json() as any;
  return BigInt(r.balance?.amount ?? "0");
};
const toFund = [];
for (const l of lenders) if ((await bal(l.address)) < 1_500_000n) toFund.push(l);
if (toFund.length) {
  const op = (await import("./accounts.js")).account;
  const from = (await op("operator")).cosmos;
  // Refused profiles send the transactions that must fail, and QoreChain charges a failed one its whole gas limit.
  await sendNative("operator", toFund.map((l) => ({
    typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: from, toAddress: l.address, amount: [{ denom: "uqor", amount: l.eligible ? "1600000" : "2200000" }] },
  })), "hybrid", 200_000 + 60_000 * toFund.length);
  console.log(`  funded ${toFund.length} lenders with 1.6 QOR each from the operator`);
  await sleep(4_000);
}
// The fest's fUSD comes only from its faucet (a person signs in to the dashboard): when the funding account has none
// left, the fUSD legs are skipped and say so, instead of failing the battery.
let fusdAvailable = false;
{
  const { client, address } = await treasuryClient(0);
  const fusdDenom = `erc20:${Q.fusd}`;
  const bal = (await (await fetch(`${REST}/cosmos/bank/v1beta1/spendable_balances/${address}/by_denom?denom=${fusdDenom}`, { headers: { "user-agent": "curl/8.7.1" } })).json()) as any;
  fusdAvailable = BigInt(bal.balance?.amount ?? "0") >= 100_000_000n;
  if (!fusdAvailable) console.log("SKIP  treasury sends 50 fest fUSD to two lenders: the funding account has no fest fUSD left (claim it at the fest faucet)");
}
if (fusdAvailable) {
  const { client, address } = await treasuryClient(0);
  const fusdDenom = `erc20:${Q.fusd}`;
  const res: any = await client.signAndBroadcast(
    [lenders[0], lenders[1]].map((l) => ({ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: address, toAddress: l.address, amount: [{ denom: fusdDenom, amount: "50000000" }] } })),
    "auto", "agama battery: fest fUSD for two lenders",
  );
  check("treasury sends 50 fest fUSD (bank form) to two lenders", res.code === 0, res.transactionHash);
}

// Each lender: canonical ML-DSA-87 key registered with proof of possession (classical tx, the only one allowed),
// then its ML-KEM-1024 key in both registries, then the sealed dossier.
const auditor = await officer("auditor");
const compliance = await officer("compliance");
await Promise.all(
  lenders.map(async (l) => {
    l.client = (await treasuryClient(l.i)).client;
    await native(l, "publish encryption key", [
      qmsg.pqc.registerKemKey({ sender: l.address, algorithmId: 2, publicKey: l.keys.mlkemPublicKey }),
      call(l, Q.access, Access, "publishEncryptionKey", [toHex(l.keys.mlkemPublicKey)]),
    ], 2_500_000);
    const dossier = {
      v: 1, name: l.name, email: `${l.name.split(" ")[0].toLowerCase()}@example.test`, country: l.country, investorType: l.investorType,
      attestations: { notUsPerson: l.country !== "US", notSanctioned: true, understandsRisk: true }, declaredAt: new Date().toISOString(),
    };
    const envelope = toHex(seal({
      chainId: SEAL.chainId, purpose: SEAL.dossier, mode: SEAL.mode, aad: aadFor(l.twin), recipients: [compliance, auditor],
      plaintext: new TextEncoder().encode(JSON.stringify(dossier)),
    }));
    await native(l, "file dossier", [call(l, Q.access, Access, "fileDossier", [envelope])], 4_500_000);
  }),
);
const keysOk = await Promise.all(lenders.map(async (l) => (await read<Hex>(Q.access, Access, "encryptionKey", [l.twin])) === toHex(l.keys.mlkemPublicKey)));
check("8 lenders registered ML-DSA-87 keys and published ML-KEM-1024 keys in parallel", keysOk.every(Boolean), `${keysOk.filter(Boolean).length}/8`);
const dossiers = await Promise.all(lenders.map((l) => read<Hex>(Q.access, Access, "dossier", [l.twin])));
check("8 sealed dossiers on chain, none readable in clear", dossiers.every((d, k) => d.startsWith("0x5153454c") && !Buffer.from(hexToBytes(d)).toString("latin1").includes(lenders[k].name)),
  `${dossiers.map((d) => (d.length - 2) / 2).join(", ")} bytes`);
console.log(`  onboarding took ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);

// ---------------------------------------------------------------------------
// B. the keeper decides
// ---------------------------------------------------------------------------

phase = "B decisions";
console.log(`\n== ${phase} (the production keeper reviews)`);
const STATUS = ["None", "Pending", "Approved", "Rejected", "Revoked"];
const waited = await until("8 decisions", async () => {
  const st = await Promise.all(lenders.map((l) => read<readonly [number]>(Q.access, Access, "members", [l.twin])));
  return st.every((m) => m[0] === 2 || m[0] === 3);
}, 15 * 60_000);
check("the keeper decided all 8 dossiers", true, `in ${(waited / 1000).toFixed(0)}s after filing`);
for (const l of lenders) {
  const m = await read<readonly [number, number, bigint, bigint, bigint, bigint, Hex]>(Q.access, Access, "members", [l.twin]);
  const found = await decisionLetter(l.twin, m[5], m[0] === 2, m[6]);
  l.letter = JSON.parse(new TextDecoder().decode(open({
    chainId: SEAL.chainId, purpose: SEAL.letter, envelope: hexToBytes(found!.letter), keys: l.keys, aad: aadFor(l.twin),
  })));
  const right = l.eligible ? m[0] === 2 && l.letter!.decision === "approved" : m[0] === 3 && l.letter!.decision === "rejected";
  check(`${l.name}: ${STATUS[m[0]]}, letter opened by its own key`, right && !!l.letter!.provenance?.postQuantum, l.letter!.reasons[0]);
}
const strangerOpens = (() => {
  try {
    open({ chainId: SEAL.chainId, purpose: SEAL.dossier, envelope: hexToBytes(dossiers[0]), keys: lenders[1].keys, aad: aadFor(lenders[0].twin) });
    return true;
  } catch { return false; }
})();
check("one lender cannot open another's dossier", !strangerOpens);
const auditorOpensAll = dossiers.every((d, k) => {
  try {
    return JSON.parse(new TextDecoder().decode(open({ chainId: SEAL.chainId, purpose: SEAL.dossier, envelope: hexToBytes(d), keys: sealKeys("auditor"), aad: aadFor(lenders[k].twin) }))).name === lenders[k].name;
  } catch { return false; }
});
check("the auditor's view key opens all 8 dossiers", auditorOpensAll);

const ok = lenders.filter((l) => l.eligible);
const refused = lenders.filter((l) => !l.eligible);

// ---------------------------------------------------------------------------
// C. transactions that must fail, really sent
// ---------------------------------------------------------------------------

phase = "C refusals";
console.log(`\n== ${phase}`);
{
  const r = refused[0];
  // Before and after, not zero: an index reused from an older battery may hold what it got while it was approved.
  const [vBefore, uBefore] = [await read<bigint>(Q.vault, Vault, "balanceOf", [r.twin]), await read<bigint>(Q.usdc, Usdc, "balanceOf", [r.twin])];
  const bad = await native(r, "deposit while refused", [
    call(r, Q.usdc, Usdc, "faucet", []), call(r, Q.usdc, Usdc, "approve", [Q.vault, maxUint256]), call(r, Q.vault, Vault, "deposit", [1_000_000_000n, r.twin]),
  ], 900_000, true);
  check("a refused lender's deposit fails on chain, atomically", bad.failed && (await read<bigint>(Q.vault, Vault, "balanceOf", [r.twin])) === vBefore && (await read<bigint>(Q.usdc, Usdc, "balanceOf", [r.twin])) === uBefore,
    "the faucet mint in the same transaction rolled back too");
  const short = await native(r, "publish a 1,000-byte key", [call(r, Q.access, Access, "publishEncryptionKey", [toHex(new Uint8Array(1000))])], 500_000, true);
  check("a key that is not ML-KEM-1024 is refused", short.failed);
  const notSealed = await native(r, "file a dossier in clear", [call(r, Q.access, Access, "fileDossier", [toHex(new TextEncoder().encode(JSON.stringify({ name: r.name, country: r.country }).padEnd(80)))])], 500_000, true);
  check("a dossier that is not a QoreSeal envelope is refused", notSealed.failed);
}

// ---------------------------------------------------------------------------
// D. six deposits at once, an fUSD on-ramp, transfers
// ---------------------------------------------------------------------------

phase = "D deposits";
console.log(`\n== ${phase}`);
const snap0 = (await read<any>(Q.vault, Vault, "snapshot"));
const sentBefore = await read<bigint>(Q.allocator, Allocator, "totalSent");
const recvBefore = (await eth.readContract({ address: E.receiver, abi: Receiver, functionName: "totalReceived" })) as bigint;
await Promise.all(ok.map(async (l) => {
  const drips = Number((l.deposit + 9_999_999_999n) / 10_000_000_000n);
  const before = await read<bigint>(Q.vault, Vault, "balanceOf", [l.twin]);
  await native(l, `deposit ${usd(l.deposit)}`, [
    ...Array.from({ length: drips }, () => call(l, Q.usdc, Usdc, "faucet", [])),
    call(l, Q.usdc, Usdc, "approve", [Q.vault, maxUint256]),
    call(l, Q.vault, Vault, "deposit", [l.deposit, l.twin]),
  ], 1_000_000 + 250_000 * drips);
  l.shares = (await read<bigint>(Q.vault, Vault, "balanceOf", [l.twin])) - before;
}));
const total = ok.reduce((a, l) => a + l.deposit, 0n);
const snap1 = await read<any>(Q.vault, Vault, "snapshot");
check("six concurrent deposits all minted agUSD", ok.every((l) => (l.shares ?? 0n) > 0n), ok.map((l) => `${formatUnits(l.shares!, 6).split(".")[0]}`).join(" / "));
// Profit unlocks by the second, so the price read after the deposits is a hair above the one each paid at.
const fair = ok.every((l) => {
  const value = (l.shares! * snap1.sharePrice) / 1_000_000n;
  const gap = value > l.deposit ? value - l.deposit : l.deposit - value;
  return gap <= l.deposit / 1_000n + 2n;
});
check("each lender got agUSD worth what it paid, to 0.1%", fair, `price ${formatUnits(snap1.sharePrice, 6)}`);
check("vault assets grew by the deposits", snap1.totalAssets - snap0.totalAssets >= (total * 999n) / 1_000n, `${usd(total)} in`);

if (!fusdAvailable) console.log("SKIP  50 fest fUSD into the vault's dollar: no fest fUSD to test with");
else {
  const l = ok[0];
  const before = await read<bigint>(Q.usdc, Usdc, "balanceOf", [l.twin]);
  await native(l, "fUSD convert + on-ramp", [
    { typeUrl: CONVERT_COIN_TYPE_URL, value: { coin: { denom: `erc20:${Q.fusd}`, amount: "50000000" }, receiver: l.twin, sender: l.address } },
    call(l, Q.fusd as Address, Usdc, "approve", [Q.fusdOnRamp, 50_000_000n]),
    call(l, Q.fusdOnRamp as Address, OnRamp, "onRamp", [50_000_000n]),
  ], 1_800_000);
  check("50 fest fUSD from the bank into the vault's dollar, one transaction", (await read<bigint>(Q.usdc, Usdc, "balanceOf", [l.twin])) - before === 50_000_000n);
}
{
  const [a, b] = [ok[1], ok[2]];
  const amount = 100_000_000n;
  const bBefore = await read<bigint>(Q.vault, Vault, "balanceOf", [b.twin]);
  await native(a, "agUSD to another approved lender", [call(a, Q.vault, Vault, "transfer", [b.twin, amount])], 800_000);
  check("agUSD moves between two approved lenders", (await read<bigint>(Q.vault, Vault, "balanceOf", [b.twin])) - bBefore === amount);
  a.shares! -= amount; b.shares! += amount;
  const refusedBefore = await read<bigint>(Q.vault, Vault, "balanceOf", [refused[0].twin]);
  const toRefused = await native(a, "agUSD to a refused account", [call(a, Q.vault, Vault, "transfer", [refused[0].twin, amount])], 600_000, true);
  check("agUSD cannot be sent to a refused account", toRefused.failed && (await read<bigint>(Q.vault, Vault, "balanceOf", [refused[0].twin])) === refusedBefore);
}

// ---------------------------------------------------------------------------
// E. the keeper allocates and bridges
// ---------------------------------------------------------------------------

phase = "E bridge";
console.log(`\n== ${phase} (the production keeper allocates)`);
const settled = await until("allocation and relay", async () => {
  const s = await read<any>(Q.vault, Vault, "snapshot");
  const sent = await read<bigint>(Q.allocator, Allocator, "totalSent");
  const recv = (await eth.readContract({ address: E.receiver, abi: Receiver, functionName: "totalReceived" })) as bigint;
  // What leaves is the excess over the 10% buffer, not a share of these deposits: when earlier exits had drained
  // the buffer, the keeper refills it first and sends only the rest.
  return sent > sentBefore && sent - sentBefore === recv - recvBefore && s.liquid * 100n <= s.totalAssets * 12n;
}, 15 * 60_000);
const sent = (await read<bigint>(Q.allocator, Allocator, "totalSent")) - sentBefore;
check("the keeper sent the new money to Ethereum and every burn was minted there", true, `${usd(sent)} in ${(settled / 1000).toFixed(0)}s`);
const s2 = await read<any>(Q.vault, Vault, "snapshot");
check("the vault kept its 10% buffer", s2.liquid * 1000n >= s2.totalAssets * 95n && s2.liquid * 100n <= s2.totalAssets * 12n, `${usd(s2.liquid)} of ${usd(s2.totalAssets)}`);
const issuer = artifact("AbfAssetIssuer").abi;
// The book wires the new cash a tick after it arrives: wait for it rather than read it in the same block.
await until("the issuer to wire the subscription", async () => {
  const [c, b] = await Promise.all(["cash", "offChainAssets"].map((f) => eth.readContract({ address: E.issuer, abi: issuer, functionName: f }))) as [bigint, bigint];
  return b * 100n >= (c + b) * 85n;
}, 10 * 60_000);
const [cash, book, maxOff] = await Promise.all(["cash", "offChainAssets", "maxOffChainBps"].map((f) => eth.readContract({ address: E.issuer, abi: issuer, functionName: f }))) as [bigint, bigint, number];
check("the issuer wired up to its 90% cap to the book", book * 10_000n <= (cash + book) * BigInt(maxOff) + 1_000_000n && book * 100n >= (cash + book) * 85n, `book ${usd(book)}, cash ${usd(cash)}`);

// ---------------------------------------------------------------------------
// F. the data room
// ---------------------------------------------------------------------------

phase = "F data room";
console.log(`\n== ${phase} (the production keeper rotates the epoch)`);
let epoch = 0n;
await until("an epoch with all six", async () => {
  const n = await read<bigint>(Q.dataRoom, Room, "epochCount");
  epoch = n - 1n;
  const m = await Promise.all(ok.map((l) => read<boolean>(Q.dataRoom, Room, "isMember", [epoch, l.twin])));
  return m.every(Boolean);
}, 15 * 60_000);
const ep = await read<any>(Q.dataRoom, Room, "epochs", [epoch]);
await until("every distribution part posted", async () => (await read<any>(Q.dataRoom, Room, "epochs", [epoch])).partsPosted === ep.parts, 10 * 60_000);
const distributionOf = async (l: Lender) => hexToBytes((await epochEnvelopeFor(epoch, l.twin)) ?? (await epochEnvelopeForAuditor(epoch))!);
await until("a tape under that epoch", async () => {
  const [r] = await read<any[]>(Q.dataRoom, Room, "latestReports", [1n]);
  return r?.epoch === epoch;
}, 15 * 60_000);
const [rep] = await read<any[]>(Q.dataRoom, Room, "latestReports", [1n]);
const repIndex = (await read<bigint>(Q.dataRoom, Room, "reportCount")) - 1n;
const rBlob = (await reportBlob(repIndex, rep.blockNumber, rep.ciphertextCommitment))!;
const parts = await Promise.all(ok.map(distributionOf));
const opened = ok.map((l, k) => {
  try {
    const ek = openEpochKey({ chainId: SEAL.chainId, purpose: SEAL.epoch, envelope: parts[k], keys: l.keys });
    const b = openBatch({ blob: hexToBytes(rBlob.blob), keys: [ek] });
    return (JSON.parse(new TextDecoder().decode(b.data)) as LoanTape).loans.length === 12 && toHex(b.ciphertextCommitment) === rep.ciphertextCommitment;
  } catch { return false; }
});
check(`all six approved lenders decrypt tape #${repIndex} of epoch ${epoch}`, opened.every(Boolean), `${ep.members} members in ${ep.parts} parts, ${(parts[0].length / 1024).toFixed(1)} kB each at most`);
const allParts = await Promise.all(Array.from({ length: Number(ep.parts) }, async (_, k) => {
  const at = await read<bigint>(Q.dataRoom, Room, "partBlock", [epoch, BigInt(k)]);
  return hexToBytes((await epochPart(epoch, BigInt(k), at))!);
}));
const refusedOpen = refused.some((l) => allParts.some((p) => {
  try { openEpochKey({ chainId: SEAL.chainId, purpose: SEAL.epoch, envelope: p, keys: l.keys }); return true; } catch { return false; }
}));
check("neither refused lender can open the epoch key", !refusedOpen);

// ---------------------------------------------------------------------------
// G. exits: three instant, three queued, at once
// ---------------------------------------------------------------------------

phase = "G exits";
console.log(`\n== ${phase}`);
const small = ok.slice(0, 3), large = ok.slice(3);
const s3 = await read<any>(Q.vault, Vault, "snapshot");
const usdcBefore = new Map(await Promise.all(ok.map(async (l) => [l.twin, await read<bigint>(Q.usdc, Usdc, "balanceOf", [l.twin])] as const)));
// Instant withdrawals first, together: sent in the same block as the queued exits, they lose the race. A queued
// claim settles from the buffer as soon as it is made (FIFO), and the battery's first run found exactly that.
await Promise.all(small.map(async (l) => {
  const shares = l.shares! / 10n;
  await native(l, "instant withdrawal", [call(l, Q.vault, Vault, "redeem", [shares, l.twin, l.twin])], 900_000);
}));
await Promise.all([
  ...large.map(async (l) => {
    const shares = (l.shares! * 9n) / 10n;
    // What the claim is worth, priced before it is sent: a claim the buffer covers is paid, and deleted, inside the
    // very transaction that makes it, so it cannot be read back afterwards.
    l.owed = await read<bigint>(Q.vault, Vault, "previewRedeem", [shares]);
    await native(l, "queued exit", [call(l, Q.vault, Vault, "requestRedeem", [shares, l.twin, l.twin])], 1_200_000);
    const ids = await read<bigint[]>(Q.vault, Vault, "requestsOf", [l.twin]);
    l.claimId = ids[ids.length - 1];
  }),
]);
const instantPaid = await Promise.all(small.map(async (l) => (await read<bigint>(Q.usdc, Usdc, "balanceOf", [l.twin])) - usdcBefore.get(l.twin)!));
check("three instant withdrawals paid from the buffer", instantPaid.every((p) => p > 0n), instantPaid.map(usd).join(" / "));
const queued = large.reduce((a, l) => a + (l.owed ?? 0n), 0n);
check("three exits above the buffer queued at the request price", large.every((l) => (l.owed ?? 0n) > 0n), `${usd(queued)} owed, buffer was ${usd(s3.liquid)}`);
const paidIn = await until("the queue to be paid", async () => {
  const next = await read<bigint>(Q.vault, Vault, "nextToSettle");
  return large.every((l) => l.claimId! < next);
}, 30 * 60_000, 15_000);
const queuedPaid = await Promise.all(large.map(async (l) => (await read<bigint>(Q.usdc, Usdc, "balanceOf", [l.twin])) - usdcBefore.get(l.twin)!));
// Paid at the price of the request block, which is at most a few seconds of unlocking from the preview.
check("the keeper brought cash home and the queue paid every claim in full", large.every((l, k) => queuedPaid[k] >= l.owed! && queuedPaid[k] - l.owed! <= l.owed! / 10_000n + 2n), `${usd(queued)} in ${(paidIn / 1000).toFixed(0)}s`);
const ids = large.map((l) => l.claimId!);
check("three distinct claims in the vault's queue, all settled", new Set(ids.map(String)).size === 3, `claims #${ids.join(", #")}`);

// ---------------------------------------------------------------------------
// H. revocation
// ---------------------------------------------------------------------------

phase = "H revocation";
console.log(`\n== ${phase}`);
{
  const v = small[1];
  const [deadline, sig] = await pqAuthorize(Q.access, Access, "compliance", "revoke", encodeAbiParameters([{ type: "address" }], [v.twin]));
  await send("qorechain", Q.access, Access, "revoke", [v.twin, deadline, sig], { label: "revoke (ML-DSA)" });
  check("compliance revokes a lender with an ML-DSA-87 signature", !(await read<boolean>(Q.access, Access, "isEligible", [v.twin])));
  const tryTransfer = await native(v, "transfer while revoked", [call(v, Q.vault, Vault, "transfer", [small[0].twin, 1_000_000n])], 800_000, true);
  check("a revoked lender cannot pass agUSD on", tryTransfer.failed);
  const held = await read<bigint>(Q.vault, Vault, "balanceOf", [v.twin]);
  const max = await read<bigint>(Q.vault, Vault, "maxRedeem", [v.twin]);
  const out = held < max ? held : max;
  const before = await read<bigint>(Q.usdc, Usdc, "balanceOf", [v.twin]);
  if (out > 0n) await native(v, "redeem while revoked", [call(v, Q.vault, Vault, "redeem", [out, v.twin, v.twin])], 900_000);
  check("a revoked lender can still take its money out", out === 0n || (await read<bigint>(Q.usdc, Usdc, "balanceOf", [v.twin])) > before, usd((await read<bigint>(Q.usdc, Usdc, "balanceOf", [v.twin])) - before));
  const prior = epoch;
  await until("an epoch without the revoked lender", async () => {
    const n = await read<bigint>(Q.dataRoom, Room, "epochCount");
    return n - 1n > prior && !(await read<boolean>(Q.dataRoom, Room, "isMember", [n - 1n, v.twin]));
  }, 15 * 60_000);
  const n = (await read<bigint>(Q.dataRoom, Room, "epochCount")) - 1n;
  const e2 = await read<any>(Q.dataRoom, Room, "epochs", [n]);
  await until("the new epoch's parts", async () => (await read<any>(Q.dataRoom, Room, "epochs", [n])).partsPosted === e2.parts, 10 * 60_000);
  let revokedOpens = false;
  for (let k = 0n; k < BigInt(e2.parts); k++) {
    const at = await read<bigint>(Q.dataRoom, Room, "partBlock", [n, k]);
    const dist = await epochPart(n, k, at);
    try { openEpochKey({ chainId: SEAL.chainId, purpose: SEAL.epoch, envelope: hexToBytes(dist!), keys: v.keys }); revokedOpens = true; } catch { /* not a reader */ }
  }
  check(`the next epoch (${n}) leaves the revoked lender out`, !revokedOpens);
}

// ---------------------------------------------------------------------------
// I. invariants
// ---------------------------------------------------------------------------

phase = "I invariants";
console.log(`\n== ${phase}`);
await sleep(30_000);
const fin = await read<any>(Q.vault, Vault, "snapshot");
check("totalAssets = idle + deployed - pending - unvested", fin.totalAssets === fin.idle + fin.deployed - fin.pending - fin.unvested);
check("the queue is empty", fin.queueLength === 0n && fin.pending === 0n);
const [sentAll, retAll] = await Promise.all([read<bigint>(Q.allocator, Allocator, "totalSent"), read<bigint>(Q.allocator, Allocator, "totalReturned")]);
const [recvAll, homeAll] = await Promise.all(["totalReceived", "totalSentHome"].map((f) => eth.readContract({ address: E.receiver, abi: Receiver, functionName: f }))) as [bigint, bigint];
const base = (await import("./vault.js")).bridgeBase();
check("bridge at rest: everything sent was received, everything sent home returned", sentAll - base.sent === recvAll && homeAll === retAll - base.returned, `${usd(sentAll)} out, ${usd(retAll)} back`);
const { navOfBook } = await import("./vault.js");
const nav = await navOfBook();
const gap = nav > fin.deployed ? nav - fin.deployed : fin.deployed - nav;
check("the vault's mark is within 1% of the book", gap * 100n <= fin.deployed + 1n, `vault ${usd(fin.deployed)}, book ${usd(nav)}`);
check("the share price did not fall during the battery", fin.sharePrice >= snap0.sharePrice, `${formatUnits(snap0.sharePrice, 6)} -> ${formatUnits(fin.sharePrice, 6)}`);
check("every lender transaction: secp256k1 and ML-DSA-87 both verify (QoreSign)", hybridOk.length > 0 && hybridOk.every(Boolean), `${hybridOk.length} transactions`);

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
const minutes = ((Date.now() - startedAt) / 60_000).toFixed(0);
console.log(`\n${results.length - failed.length}/${results.length} checks passed, ${txCount} lender transactions, ${minutes} min`);
const day = new Date().toISOString().slice(0, 10);
mkdirSync(join(ROOT, "docs/battery"), { recursive: true });
const md = [
  `# Battery, ${day}`,
  "",
  `${lenders.length} lenders (6 eligible, 2 refused) on qorechain-diana, the production keeper running on GitHub Actions. ` +
    `${txCount} lender transactions, all real. **${results.length - failed.length}/${results.length} checks passed** in ${minutes} minutes.`,
  "",
  "| Phase | Check | Result | Detail |",
  "|---|---|---|---|",
  ...results.map((r) => `| ${r.phase} | ${r.name} | ${r.ok ? "PASS" : "**FAIL**"} | ${r.detail.replace(/\|/g, "/")} |`),
  "",
  "Lenders:",
  "",
  ...lenders.map((l) => `- ${l.name} (${l.country}, ${l.investorType}): \`${l.address}\`, ${l.letter?.decision ?? "?"}`),
  ...(findings.length ? ["", "Findings:", "", ...findings.map((f) => `- ${f}`)] : []),
  "",
].join("\n");
writeFileSync(join(ROOT, `docs/battery/${day}.md`), md);
process.exit(failed.length ? 1 : 0);
