/**
 * Repairs FINDINGS 17 on the live testnet. The hybrid Ethereum messenger (v2) counted nonces from 1 into nonces its
 * predecessor had spent on QoreChain, so its first return ($2,493.43) was burned on Ethereum and refused on
 * QoreChain, and its next eleven would have been too. This:
 *
 *   1  advances the v2 messenger's counter past the spent range with dust burns (1 micro-USDC each, never relayed)
 *   2  brings every dollar home from the v2 receiver, now on fresh nonces
 *   3  has the issuer's custody re-send the burned $2,493.43 through the receiver, so no lender loses anything
 *
 *   tsx src/repair-nonce.ts
 */
import { keccak256, pad, toHex, type Address } from "viem";
import { account } from "./accounts.js";
import { E } from "./config.js";
import { artifact, write } from "./evm.js";
import { eth, sleep } from "./net.js";
import { relayAll } from "./relay.js";
import { bringHome } from "./book.js";
import { snapshot } from "./vault.js";

const LOST = 2_493_431_483n; // the refused return, 0x949f3ebb
const legacySent = (await eth.readContract({ address: E.legacy.messenger, abi: artifact("AttestedMessenger").abi, functionName: "sent" })) as bigint;
const messengerAbi = artifact("HybridAttestedMessenger").abi;
const usdcAbi = artifact("MockUSDC").abi;
const op = (await account("operator")).evm as Address;

// 1. dust burns past the spent nonces
let sent = (await eth.readContract({ address: E.messenger, abi: messengerAbi, functionName: "sent" })) as bigint;
if (sent <= legacySent) {
  const n = legacySent - sent + 1n;
  console.log(`messenger at ${sent}, predecessor spent up to ${legacySent}: ${n} dust burns`);
  await write("sepolia", "operator", E.usdc, usdcAbi, "mint", [op, n]);
  await write("sepolia", "operator", E.usdc, usdcAbi, "approve", [E.messenger, n]);
  for (let i = 0n; i < n; i++) {
    await write("sepolia", "operator", E.messenger, messengerAbi, "depositForBurn", [1n, 9800, pad(op, { size: 32 }), E.usdc, pad("0x00", { size: 32 }), 0n, 2000]);
  }
  sent = (await eth.readContract({ address: E.messenger, abi: messengerAbi, functionName: "sent" })) as bigint;
  console.log(`messenger now at ${sent}`);
}

// 2. everything home
const R = artifact("AgamaL1Receiver").abi;
const position = (await eth.readContract({ address: E.receiver, abi: R, functionName: "positionValue" })) as bigint;
if (position > 0n) await bringHome(position + 1_000_000n);
await relayAll();

// 3. custody makes the burned return good: mint it to the receiver, which sends it home on a fresh nonce
const replaced = await eth.readContract({ address: E.usdc, abi: usdcAbi, functionName: "balanceOf", args: [E.receiver] }) as bigint;
if (replaced < LOST && process.env.REPLACED !== "1") {
  await write("sepolia", "operator", E.usdc, usdcAbi, "mint", [E.receiver, LOST]);
  await write("sepolia", "operator", E.receiver, R, "sendHome", [LOST]);
}
for (let i = 0; i < 6; i++) {
  await relayAll();
  const s = await snapshot();
  console.log(`vault deployed ${Number(s.deployed) / 1e6}, pending ${Number(s.pending) / 1e6}`);
  if (s.deployed === 0n) break;
  await sleep(15_000);
}
void keccak256;
void toHex;
