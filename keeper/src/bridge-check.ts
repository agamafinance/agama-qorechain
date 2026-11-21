/**
 * The bridge without logs: every allocation message the QoreChain messenger ever logged (MessageSent, from the EVM
 * lane), rebuilt from the transaction's calldata and contract state alone (chain.ts allocationMessage), must be
 * identical byte for byte. A native allocation leaves no log, so this is what the relayer and the attester rely on.
 *
 *   tsx src/bridge-check.ts
 */
import { parseAbiItem } from "viem";
import { allocationMessage } from "./chain.js";
import { Q } from "./config.js";
import { qore } from "./net.js";

const ev = parseAbiItem("event MessageSent(bytes message)");
const head = await qore.getBlockNumber();
const logs: any[] = [];
for (let f = BigInt(Q.deployedAtBlock); f <= head; f += 10_000n)
  logs.push(...(await qore.getLogs({ address: Q.messenger, event: ev, fromBlock: f, toBlock: f + 9_999n > head ? head : f + 9_999n })));
let ok = 0;
let n = 0;
for (const l of logs) {
  const tx = await qore.getTransaction({ hash: l.transactionHash! });
  if (tx.to?.toLowerCase() !== Q.allocator.toLowerCase()) continue;
  n++;
  const m = await allocationMessage({ hash: l.transactionHash!, height: Number(l.blockNumber), time: "", memo: "", sender: "", target: Q.allocator, data: tx.input, gasUsed: 0 });
  if (m?.toLowerCase() === l.args.message.toLowerCase()) ok++;
  else console.log(`DIFF ${l.transactionHash}`);
}
console.log(`${ok}/${n} allocation messages rebuilt from calldata and state are identical to their MessageSent logs`);
process.exit(ok === n && n > 0 ? 0 : 1);
