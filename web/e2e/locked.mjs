// A QoreX that locked itself (another tab, the auto-lock timer): the first signing request is refused with "wallet
// is locked". The app must open QoreX's unlock screen (enable) and ask again, not show the error. Lender 13.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { chromium } from 'playwright';
import { createPublicClient, http, parseAbi } from 'viem';
import { createQorexMock } from '@qorechain/qorex-wallet-mock';

const BASE = process.env.APP_URL ?? 'http://localhost:3034/qorechain';
const Q = JSON.parse(readFileSync(new URL('../../deployments/qorechain-diana.json', import.meta.url), 'utf8'));
const file = `${homedir()}/.config/qorechain/agama-funder.mnemonic`;
const mnemonic = process.env.QORE_FUNDER_MNEMONIC ?? (existsSync(file) ? readFileSync(file, 'utf8').trim() : null);
const evm = createPublicClient({ transport: http('https://evm-testnet.qore.host') });
const mock = createQorexMock({ profile: 'planned', mnemonic, accountIndex: Number(process.env.LENDER_INDEX ?? 13), chainId: 'qorechain-diana', rest: `${BASE}/api/rest` });
const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript({ content: mock.initScript() });
// Lock it after connect: the next signArbitrary is refused once, and enable() records that the unlock screen opened.
await page.addInitScript(() => {
  const t = setInterval(() => {
    const n = window.qorex?.native;
    if (!n || n.__wrapped) return;
    n.__wrapped = true;
    clearInterval(t);
    const sign = n.signArbitrary.bind(n), enable = n.enable.bind(n);
    window.__lock = { locked: false, unlockScreens: 0 };
    n.signArbitrary = async (...a) => {
      if (window.__lock.locked) throw new Error('QoreX: wallet is locked');
      return sign(...a);
    };
    n.enable = async (...a) => {
      if (window.__lock.locked) { window.__lock.unlockScreens++; window.__lock.locked = false; }
      return enable(...a);
    };
  }, 20);
});
await page.goto(`${BASE}/faucet`);
await page.getByRole('button', { name: /Connect/ }).first().click();
const btn = page.getByRole('button', { name: /Get 10,000 USDC/ });
await btn.waitFor({ timeout: 30_000 });
const owner = await page.evaluate(async () => '0x' + (await window.qorex.native.getKey('qorechain-diana')).address.map((b) => b.toString(16).padStart(2, '0')).join(''));
const twin = await evm.readContract({ address: Q.pqAccountFactory, abi: parseAbi(['function accountOf(address) view returns (address)']), functionName: 'accountOf', args: [owner] });
const bal = () => evm.readContract({ address: Q.usdc, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [twin] });
const before = await bal();
await page.evaluate(() => (window.__lock.locked = true));
await btn.click();
let after = before;
for (let i = 0; i < 60 && after === before; i++) { await page.waitForTimeout(1500); after = await bal(); }
const lock = await page.evaluate(() => window.__lock);
const shown = await page.getByText(/wallet is locked/i).count();
await browser.close();
const ok = lock.unlockScreens === 1 && after > before && shown === 0;
console.log(`${ok ? 'PASS' : 'FAIL'}  locked QoreX: unlock screen opened ${lock.unlockScreens}x, USDC ${Number(before) / 1e6} -> ${Number(after) / 1e6}, "locked" error shown ${shown}x`);
process.exit(ok ? 0 : 1);
