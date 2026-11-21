// Browser end to end: the real app, the official QoreX test double (@qorechain/qorex-wallet-mock: real hybrid
// secp256k1 + ML-DSA-87 signing, real broadcast to qorechain-diana) and on-chain assertions after every step.
// The lender is the QoreX account (coin 118) index 14 of the funding mnemonic: an ML-DSA-87 key, nothing else.
// The keeper must be running (keeper: `npm run loop`): it is the compliance officer and the data room manager.
//
//   npm run build && npm start &      # port 3034
//   node e2e/browser.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { chromium } from 'playwright';
import { createPublicClient, http, parseAbi } from 'viem';
import { createQorexMock } from '@qorechain/qorex-wallet-mock';

const BASE = process.env.APP_URL ?? 'http://localhost:3034/qorechain';
const Q = JSON.parse(readFileSync(new URL('../../deployments/qorechain-diana.json', import.meta.url), 'utf8'));
const file = `${homedir()}/.config/qorechain/agama-funder.mnemonic`;
const mnemonic = process.env.QORE_FUNDER_MNEMONIC ?? (existsSync(file) ? readFileSync(file, 'utf8').trim() : null);
if (!mnemonic) throw new Error('set QORE_FUNDER_MNEMONIC');
const SHOTS = new URL('./shots/', import.meta.url).pathname;
// The lender's QoreSeal seed survives between runs the way a user's backup file does (gitignored).
const SEED_FILE = new URL(`./.lender-seed-${process.env.LENDER_INDEX ?? 14}`, import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const evm = createPublicClient({ transport: http('https://evm-testnet.qore.host') });
const abi = parseAbi([
  'function isEligible(address) view returns (bool)',
  'function encryptionKey(address) view returns (bytes)',
  'function balanceOf(address) view returns (uint256)',
  'function dossier(address) view returns (bytes)',
]);
const read = (address, functionName, args) => evm.readContract({ address, abi, functionName, args });

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = (await fn()) ?? '';
    results.push({ name, ok: true });
    console.log(`PASS  ${name}  ${detail}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}  ${String(e?.message ?? e).split('\n')[0].slice(0, 240)}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(`assertion failed: ${m}`);
};

const mock = createQorexMock({ profile: 'planned', mnemonic, accountIndex: Number(process.env.LENDER_INDEX ?? 14), chainId: 'qorechain-diana', rest: `${BASE}/api/rest` });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
await page.addInitScript({ content: mock.initScript() });
const shot = (name) => page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: true });
const waitText = (text, timeout = 120_000) => page.getByText(text, { exact: false }).first().waitFor({ timeout });

let twin;
if (process.env.TRACE) {
  page.on('request', (r) => { if (r.url().includes('/api/relay')) console.log('  > relay', new Date().toISOString(), (JSON.parse(r.postData() ?? '{}').summary ?? '')); });
  page.on('response', async (r) => { if (r.url().includes('/api/relay')) console.log('  < relay', new Date().toISOString(), r.status(), (await r.text().catch(() => '')).slice(0, 160)); });
}
// A navigation reloads the app; the wallet reconnects by itself most of the time, not always. Connect again when the
// header still offers it, and wait until the account is there (the header shows the account instead).
async function go(path) {
  await page.goto(`${BASE}${path}`);
  await ensureConnected();
}
async function ensureConnected() {
  const connected = () => page.waitForFunction(() => !/Connect QoreX/.test(document.querySelector('header')?.innerText ?? ''), null, { timeout: 15_000 }).then(() => true).catch(() => false);
  for (let i = 0; i < 3; i++) {
    const again = page.getByRole('button', { name: /Connect QoreX/ }).filter({ visible: true }).first();
    // The button shows before it acts (the app waits for QoreX to inject itself), and the app may reconnect by itself.
    if (await again.isVisible({ timeout: 5_000 }).catch(() => false)) await again.click({ timeout: 10_000 }).catch(() => {});
    if (await connected()) return;
  }
}

await check('connect QoreX', async () => {
  // Connects only if the app did not reconnect by itself (it does, when QoreX already granted this site).
  await go('/access');
  await page.waitForFunction(() => document.body.innerText.includes('Your encryption key'), null, { timeout: 30_000 });
  const owner = await page.evaluate(async () => {
    const k = await window.qorex.native.getKey('qorechain-diana');
    return '0x' + k.address.map((b) => b.toString(16).padStart(2, '0')).join('');
  });
  // The lender's Agama account: the PqAccount its ML-DSA-87 key controls, known before it exists.
  twin = (await evm.readContract({ address: Q.pqAccountFactory, abi: parseAbi(['function accountOf(address) view returns (address)']), functionName: 'accountOf', args: [owner] })).toLowerCase();
  if (existsSync(SEED_FILE)) {
    const seed = readFileSync(SEED_FILE, 'utf8').trim();
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [`agama-qore:seal:${twin.toLowerCase()}`, seed]);
    await page.reload();
    await ensureConnected();
    await page.waitForFunction(() => /Published and bound|Create my key|Publish my key/.test(document.body.innerText), null, { timeout: 60_000 });
  }
  return twin;
});

await check('create the QoreSeal key in the browser and publish it (AccessRegistry, through the relayer)', async () => {
  // Decide only once the page has read the chain: a button seen while it loads is not the state.
  await page.waitForFunction(() => /Published and bound|Create my key|Publish my key/.test(document.body.innerText), null, { timeout: 60_000 });
  await page.waitForTimeout(2_000);
  const create = page.getByRole('button', { name: /Create my key/ });
  if (!(await page.getByText('Published and bound').first().isVisible()) && (await create.isVisible())) {
    await create.click();
    const seed = await page.evaluate((k) => localStorage.getItem(k), `agama-qore:seal:${twin.toLowerCase()}`);
    writeFileSync(SEED_FILE, seed, { mode: 0o600 });
  }
  const publish = page.getByRole('button', { name: /Publish my key/ });
  if (!(await page.getByText('Published and bound').first().isVisible()) && (await publish.isVisible())) await publish.click();
  await waitText('Published and bound to your account', 180_000);
  const k = await read(Q.access, 'encryptionKey', [twin]);
  assert(k.length === 2 + 1568 * 2, 'ML-KEM-1024 key on chain');
  await shot('1-key');
  return `${(k.length - 2) / 2} bytes on chain`;
});

await check('seal the application in the browser and file it', async () => {
  if (await read(Q.access, 'isEligible', [twin])) return 'already approved';
  await page.getByPlaceholder('Legal name').fill('Camille Durand');
  await page.getByPlaceholder('Email (optional)').fill('camille@example.test');
  await page.getByPlaceholder('Entity (optional)').fill('Durand Capital SARL');
  for (const l of ['not a US person', 'not subject to sanctions', 'I understand']) await page.getByText(l).click();
  await page.getByRole('button', { name: /Seal it in this browser/ }).click();
  await waitText('What the chain will see');
  await shot('2-sealed');
  await page.getByRole('button', { name: /File it on chain/ }).click();
  await waitText('Filed.', 90_000);
  const d = await read(Q.access, 'dossier', [twin]);
  assert(d.startsWith('0x5153454c'), 'QSEL envelope');
  assert(!Buffer.from(d.slice(2), 'hex').toString('latin1').includes('Durand'), 'no plaintext on chain');
  return `${(d.length - 2) / 2} bytes of ciphertext, no plaintext`;
});

await check('the keeper approves it with ML-DSA-87; the lender opens the sealed letter', async () => {
  await waitText('Approved until', 240_000);
  await page.getByRole('button', { name: /Open the sealed letter/ }).click();
  await waitText('Decrypted here with your ML-KEM-1024');
  await shot('3-letter');
  assert(await read(Q.access, 'isEligible', [twin]), 'eligible on chain');
  return (await page.getByText(/investor$/).first().textContent()) ?? '';
});

await check('mint mock USDC from the faucet', async () => {
  const before = await read(Q.usdc, 'balanceOf', [twin]);
  await go('/faucet');
  await page.getByRole('button', { name: /Get 10,000 USDC/ }).click();
  // The public RPC is load balanced: wait for the exact amount, so a node one block behind cannot answer the last read.
  let after = before;
  for (let i = 0; i < 80 && after - before !== 10_000_000_000n; i++) {
    await page.waitForTimeout(1500);
    after = await read(Q.usdc, 'balanceOf', [twin]);
  }
  const toast = (await page.locator('[role=status]').allTextContents()).join(' | ');
  assert(after - before === 10_000_000_000n, `minted 10,000 (toast: ${toast.slice(0, 160)})`);
  return `${Number(after) / 1e6} USDC`;
});

await check('deposit 2,500 USDC into agUSD, one QoreX signature', async () => {
  const before = await read(Q.vault, 'balanceOf', [twin]);
  await go('/');
  await page.locator('input[inputmode="decimal"]').first().fill('2500');
  await page.getByRole('button', { name: /Deposit and start earning/ }).click();
  for (let i = 0; i < 40 && (await read(Q.vault, 'balanceOf', [twin])) === before; i++) await page.waitForTimeout(1500);
  const after = await read(Q.vault, 'balanceOf', [twin]);
  assert(after > before, 'agUSD minted');
  await shot('4-earn');
  return `${Number(after - before) / 1e6} agUSD`;
});

await check('portfolio shows the position and the access', async () => {
  await go('/portfolio');
  await waitText('Approved lender until', 30_000);
  await waitText('Agama USD');
  await shot('5-portfolio');
});

await check('data room: the next epoch includes the lender, who decrypts the loan tape', async () => {
  await go('/data-room');
  // The tape opens by itself for a member whose key is in this browser; the button is only a fallback.
  await page.getByText(/ciphertext matches its on-chain commitment|Decrypt in this browser/).first().waitFor({ timeout: 300_000 });
  const btn = page.getByRole('button', { name: /Decrypt in this browser/ });
  // It can open by itself between the check and the click: then there is nothing to click.
  if (await btn.isVisible().catch(() => false)) await btn.click({ timeout: 5_000 }).catch(() => {});
  await waitText('ciphertext matches its on-chain commitment', 60_000);
  const rows = await page.locator('tbody tr').count();
  assert(rows === 12, `12 facilities, got ${rows}`);
  await shot('6-data-room');
  return `${rows} facilities decrypted`;
});

await check('no uncaught page errors', async () => {
  assert(errors.length === 0, errors.join(' | '));
});

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
process.exit(failed ? 1 : 0);
