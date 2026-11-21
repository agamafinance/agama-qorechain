/**
 * Brings everything faucet addresses received to the funding account (index 0 of the funding mnemonic, the QoreX
 * wallet the tests and the gas tank draw from): the fest's fUSD (bank form) and the QOR, less this transfer's fee.
 * Each address signs its own transfer, hybrid (secp256k1 + ML-DSA-87).
 *
 *   tsx src/collect.ts 103 106
 */
import { treasury } from "./accounts.js";
import { Q } from "./config.js";
import { treasuryClient } from "./native.js";
import { rest } from "./net.js";

const [from, to] = process.argv.slice(2).map(Number);
const home = (await treasury(0)).native.address;
const FUSD = `erc20:${Q.fusd}`;
const FEE = 300_000n;
let fusd = 0n;
let qor = 0n;
for (let i = from; i <= to; i++) {
  const addr = (await treasury(i)).native.address;
  const b = await rest<any>(`/cosmos/bank/v1beta1/spendable_balances/${addr}`).catch(() => ({ balances: [] }));
  const of = (d: string) => BigInt((b.balances ?? []).find((x: any) => x.denom === d)?.amount ?? "0");
  const f = of(FUSD);
  const u = of("uqor");
  if (u <= FEE) {
    console.log(`  #${i} ${addr}: ${Number(u) / 1e6} QOR, not enough for the fee; fUSD ${Number(f) / 1e6} left there`);
    continue;
  }
  // The chain refuses coins not sorted by denomination: erc20:… before uqor.
  const amount = [...(f > 0n ? [{ denom: FUSD, amount: String(f) }] : []), { denom: "uqor", amount: String(u - FEE) }].sort((a, b) => (a.denom < b.denom ? -1 : 1));
  try {
    const { client } = await treasuryClient(i);
    const res: any = await client.signAndBroadcast(
      [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: addr, toAddress: home, amount } }],
      { amount: [{ denom: "uqor", amount: "250000" }], gas: "1000000" },
      "agama: faucet address to the funding account",
    );
    if (res.code) throw new Error(res.rawLog);
    fusd += f;
    qor += u - FEE;
    console.log(`  #${i} ${addr}: ${Number(f) / 1e6} fUSD + ${Number(u - FEE) / 1e6} QOR -> ${home} (${res.transactionHash})`);
  } catch (e) {
    console.log(`  #${i}: ${(e as Error).message.split("\n")[0]}`);
  }
}
console.log(`collected ${Number(fusd) / 1e6} fUSD and ${Number(qor) / 1e6} QOR to ${home}`);
