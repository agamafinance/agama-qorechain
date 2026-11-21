// Every kind of Agama transaction, as QoreChain's explorer shows it: "quantum-safe · verified on-chain", ML-DSA-87.
// The explorer opens on mainnet; the cookie it sets when you pick Testnet (qore-network=testnet) is set here.
//   node e2e/explorer.mjs <label=HASH> ...
import { chromium } from 'playwright';

const pairs = process.argv.slice(2).map((a) => a.split('='));
const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addCookies([{ name: 'qore-network', value: 'testnet', domain: 'explore.qore.network', path: '/' }]);
const page = await ctx.newPage();
let ok = 0;
for (const [label, hash] of pairs) {
  await page.goto(`https://explore.qore.network/tx/${hash}`, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(2500);
  const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  const safe = /Signature security\s*quantum-safe\s*·?\s*verified on-chain/i.test(text);
  const notSafe = /not quantum-safe/i.test(text);
  const mldsa = /ML-DSA-87|Dilithium/i.test(text);
  const pass = safe && !notSafe && mldsa;
  if (pass) ok++;
  const snippet = (text.match(/.{0,40}quantum-safe.{0,60}/i) ?? [''])[0];
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(28)} ${hash.slice(0, 12)}…  ${snippet}`);
}
await browser.close();
console.log(`\n${ok}/${pairs.length} transactions shown "quantum-safe · verified on-chain" with ML-DSA-87`);
process.exit(ok === pairs.length ? 0 : 1);
