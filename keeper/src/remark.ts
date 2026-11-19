/**
 * Brings the vault's mark back to the book after a wrong mark-down, without charging a performance fee on a gain
 * that only undoes it: the admin sets the fee to 0 (ML-DSA-87 signed), the reporter walks the mark up in the
 * contract's 5% steps, then the admin restores the fee.
 *
 *   tsx src/remark.ts
 */
import { encodeAbiParameters } from "viem";
import { Q, send } from "./config.js";
import { artifact, pqAuthorize, pqCall } from "./evm.js";
import { qore, sleep } from "./net.js";
import { navOfBook, snapshot } from "./vault.js";

const abi = artifact("AgUSD").abi;
const CONFIG = [{ type: "tuple", components: [
  { name: "depositCap", type: "uint256" }, { name: "reserveBps", type: "uint16" }, { name: "performanceFeeBps", type: "uint16" },
  { name: "maxNavChangeBps", type: "uint16" }, { name: "minReportInterval", type: "uint32" }, { name: "profitVestingPeriod", type: "uint32" },
  { name: "feeRecipient", type: "address" },
] }] as const;

const c = (await qore.readContract({ address: Q.vault, abi, functionName: "config" })) as any[];
const cfg = { depositCap: c[0], reserveBps: c[1], performanceFeeBps: c[2], maxNavChangeBps: c[3], minReportInterval: c[4], profitVestingPeriod: c[5], feeRecipient: c[6] };
const setFee = (fee: number) => {
  const next = { ...cfg, performanceFeeBps: fee };
  return pqCall(Q.vault, abi, "setConfig", "operator", "setConfig", encodeAbiParameters(CONFIG, [next]), [next]);
};

console.log(`fee ${cfg.performanceFeeBps} bps -> 0 for the re-mark`);
await setFee(0);
for (;;) {
  const [s, nav] = [await snapshot(), await navOfBook()];
  console.log(`vault marks the book at ${Number(s.deployed) / 1e6}, the book is worth ${Number(nav) / 1e6}`);
  if (nav <= s.deployed) break;
  const wait = Number(s.lastReport) + Number(cfg.minReportInterval) + 15 - Date.now() / 1000;
  if (wait > 0) await sleep(wait * 1000);
  const max = (s.deployed * BigInt(cfg.maxNavChangeBps)) / 10_000n;
  const next = nav > s.deployed + max ? s.deployed + max : nav;
  const [deadline, sig] = await pqAuthorize(Q.vault, abi, "reporter", "reportNav", encodeAbiParameters([{ type: "uint256" }], [next]));
  await send("qorechain", Q.vault, abi, "reportNav", [next, deadline, sig], { label: "reportNav (ML-DSA)" });
}
console.log(`fee back to ${cfg.performanceFeeBps} bps`);
await setFee(cfg.performanceFeeBps);
console.log("price", Number((await snapshot()).sharePrice) / 1e6);
