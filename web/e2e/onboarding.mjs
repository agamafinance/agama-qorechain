// Browser end to end of the simple path: a brand-new lender does everything from the Earn page. Get verified (one
// form, one button, two QoreX signatures: the encryption key is made and published, the answers sealed and filed),
// wait for the running keeper's decision, get test USDC from the card, deposit, then open the data room, which
// decrypts by itself. Real hybrid signatures (official QoreX test double), real transactions on qorechain-diana.
//
//   node e2e/onboarding.mjs          LENDER_INDEX (default 3) must be funded: keeper `tsx src/lender.ts 6 3`
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { chromium } from 'playwright';
import { createPublicClient, http, parseAbi } from 'viem';
import { createQorexMock } from '@qorechain/qorex-wallet-mock';

const BASE = process.env.APP_URL ?? 'http://localhost:3034/qorechain';
const Q = JSON.parse(readFileSync(new URL('../../deployments/qorechain-diana.json', import.meta.url), 'utf8'));
const file = `${homedir()}/.config/qorechain/agama-funder.mnemonic`;
const mnemonic = process.env.QORE_FUNDER_MNEMONIC ?? (existsSync(file) ? readFileSync(file, 'utf8').trim() : null);
const SEED = new URL(`./.lender-seed-onb-${process.env.LENDER_INDEX ?? 3}`, import.meta.url).pathname;
const evm = createPublicClient({ transport: http('https://evm-testnet.qore.host') });
const abi = parseAbi(['function isEligible(address) view returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const read = (address, functionName, args) => evm.readContract({ address, abi, functionName, args });

const results = [];
async function check(name, fn) {
  try {
    const d = (await fn()) ?? '';
    results.push(true);
    console.log(`PASS  ${name}  ${d}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL  ${name}  ${String(e?.message ?? e).split('\n')[0].slice(0, 220)}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(`assertion failed: ${m}`);
};

const mock = createQorexMock({ profile: 'current', mnemonic, accountIndex: Number(process.env.LENDER_INDEX ?? 3), chainId: 'qorechain-diana', rest: `${BASE}/api/rest` });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript({ content: mock.initScript() });
const text = (t, timeout = 60_000) => page.getByText(t, { exact: false }).first().waitFor({ timeout });
let twin;

await check('the navigation is Earn, Portfolio, Data room, Faucet', async () => {
  await page.goto(`${BASE}/`);
  const nav = await page.locator('header nav').first().innerText();
  assert(/Earn/.test(nav) && /Portfolio/.test(nav) && /Data room/.test(nav) && /Faucet/.test(nav) && !/Access/.test(nav), nav);
});

await check('a new lender sees the verification in the deposit card', async () => {
  await page.getByRole('button', { name: /Connect/ }).first().click();
  // A rerun finds the same lender already verified: the card is then the deposit form.
  await page.getByText(/Get verified to deposit|Deposit USDC/).first().waitFor({ timeout: 30_000 });
  twin = await page.evaluate(async () => {
    const k = await window.qorex.native.getKey('qorechain-diana');
    return '0x' + k.address.map((b) => b.toString(16).padStart(2, '0')).join('');
  });
  // The lender's key survives between runs the way its backup file would.
  if (existsSync(SEED)) await page.evaluate(([k, v]) => localStorage.setItem(k, v), [`agama-qore:seal:${twin.toLowerCase()}`, readFileSync(SEED, 'utf8').trim()]);
  return twin;
});

await check('one form and one button: key made, published, answers sealed and filed', async () => {
  if (await read(Q.access, 'isEligible', [twin])) return 'already verified';
  await page.getByPlaceholder('Full legal name').fill('Inès Moreau');
  await page.getByText('I am not a US person').click();
  await page.getByRole('button', { name: 'Get verified' }).click();
  await text('Checking your application', 120_000);
  const seed = await page.evaluate((k) => localStorage.getItem(k), `agama-qore:seal:${twin.toLowerCase()}`);
  if (seed) writeFileSync(SEED, seed, { mode: 0o600 });
});

await check('the keeper decides; the card turns into the deposit form by itself', async () => {
  await text('Deposit USDC', 240_000);
  assert(await read(Q.access, 'isEligible', [twin]), 'eligible on chain');
});

await check('test USDC from the card, then a deposit, all on Earn', async () => {
  const usdcBtn = page.getByRole('button', { name: /Get 10,000 test USDC/ });
  // The button appears once the balance is read and is zero.
  if ((await read(Q.usdc, 'balanceOf', [twin])) === 0n) {
    await usdcBtn.waitFor({ timeout: 30_000 });
    await usdcBtn.click();
    for (let i = 0; i < 60 && (await read(Q.usdc, 'balanceOf', [twin])) === 0n; i++) await page.waitForTimeout(1500);
  }
  const before = await read(Q.vault, 'balanceOf', [twin]);
  await page.locator('input[inputmode="decimal"]').first().fill('1000');
  const btn = page.getByRole('button', { name: /Deposit and start earning/ });
  if (!(await btn.isVisible({ timeout: 20_000 }).catch(() => false))) {
    const card = await page.getByText('Deposit USDC').first().locator('xpath=../..').innerText();
    throw new Error(`deposit button not shown; card says: ${card.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  await btn.click();
  for (let i = 0; i < 60 && (await read(Q.vault, 'balanceOf', [twin])) === before; i++) await page.waitForTimeout(1500);
  const after = await read(Q.vault, 'balanceOf', [twin]);
  assert(after > before, 'agUSD minted');
  await page.screenshot({ path: new URL('./shots/onboarding-earn.png', import.meta.url).pathname });
  return `${Number(after - before) / 1e6} agUSD`;
});

await check('the data room opens by itself once the next epoch includes the lender', async () => {
  for (let i = 0; i < 40; i++) {
    await page.goto(`${BASE}/data-room`);
    if (await page.getByText('ciphertext matches its on-chain commitment').first().isVisible({ timeout: 15_000 }).catch(() => false)) break;
    await page.waitForTimeout(15_000);
  }
  await text('ciphertext matches its on-chain commitment', 10_000);
  assert((await page.locator('tbody tr').count()) === 12, '12 facilities');
  await page.screenshot({ path: new URL('./shots/onboarding-data-room.png', import.meta.url).pathname, fullPage: true });
});

await check('no uncaught page errors', async () => assert(errors.length === 0, errors.join(' | ')));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} onboarding checks passed`);
process.exit(failed ? 1 : 0);
