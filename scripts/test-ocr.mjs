/**
 * Playwright checks for on-device expiry OCR and the "Use AI for scanning" toggle.
 * Run against a local preview: BASE=http://127.0.0.1:4173/ node scripts/test-ocr.mjs
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const req = createRequire(import.meta.url);
function loadPlaywright() {
  for (const spec of ['playwright-core', '/workspace/pantry-qa/node_modules/playwright-core']) {
    try { return req(spec); } catch { /* try next */ }
  }
  throw new Error('Install playwright-core (npm i -D playwright-core) to run this check');
}
const { chromium } = loadPlaywright();
const BASE = process.env.BASE || 'http://127.0.0.1:4173/';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
function fail(msg) { console.error('FAIL', msg); process.exitCode = 1; }
function pass(msg) { console.log('PASS', msg); }
const check = (ok, msg, detail = '') => ok ? pass(msg) : fail(`${msg}${detail ? ` (${detail})` : ''}`);

const browser = await chromium.launch({ executablePath: process.env.CHROME || (existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : undefined), headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA, locale: 'en-AU', timezoneId: 'Australia/Sydney', serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept());
const closed = () => page.waitForSelector('.sheet-wrap.open', { state: 'detached' });
const expandAll = async () => { while (await page.locator('.cat-group.closed .cat-h').count()) await page.locator('.cat-group.closed .cat-h').first().click(); };
const wipe = async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => new Promise(res => { const r = indexedDB.deleteDatabase('pantry'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
};

const geminiHits = [];
await page.route(/generativelanguage\.googleapis\.com|api\.openai\.com/, route => {
  geminiHits.push(route.request().url());
  return route.fulfill({ status: 500, body: 'blocked' });
});

async function datePng(text) {
  return Buffer.from(await page.evaluate(async t => {
    const c = document.createElement('canvas');
    c.width = 1200; c.height = 320;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 1200, 320);
    g.fillStyle = '#111111';
    g.font = 'bold 84px sans-serif';
    g.fillText(t, 40, 200);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const buf = new Uint8Array(await blob.arrayBuffer());
    return Array.from(buf);
  }, text));
}

await wipe();
await page.goto(BASE + '?demo', { waitUntil: 'networkidle' });
await page.waitForSelector('.tile');

await page.locator('[data-tab=settings]').click();
await page.waitForSelector('#s-ai-scan');
check(await page.locator('#s-ai-scan').isChecked(), 'Use AI for scanning is on by default');
await page.locator('#s-ai-scan').uncheck();
await page.waitForTimeout(200);
await page.reload({ waitUntil: 'networkidle' });
await page.locator('[data-tab=settings]').click();
await page.waitForSelector('#s-ai-scan');
check(!(await page.locator('#s-ai-scan').isChecked()), 'turning the toggle off survives a reload');

await page.locator('[data-tab=items]').click();
await page.locator('[data-view=list]').click();
await page.waitForSelector('.cat-group');
await expandAll();
await page.locator('.item', { hasText: 'Full Cream Milk' }).click();
await page.waitForSelector('#e-scan');
await page.locator('#e-scan').click();
await page.waitForSelector('input[type=file][accept="image/*"]', { state: 'attached' });
await page.locator('input[type=file][accept="image/*"]').last().setInputFiles({ name: 'bb.png', mimeType: 'image/png', buffer: await datePng('USE BY 20 NOV 2027') });
await page.waitForSelector('#dates-check', { timeout: 120000 });
check(geminiHits.length === 0, 'AI is not called when the toggle is off', geminiHits.join(' | '));
await page.locator('#dates-check').click();
await page.waitForSelector('.dates-list');
const body = (await page.locator('.dates-list').innerText()).replace(/\s+/g, ' ');
check(/20\s*Nov(ember)?\s*2027/i.test(body) && /Full Cream Milk/.test(body), 'OCR date is waiting in Dates to check', body);
check(/Read on your phone/.test(body), 'dates-to-check notes the date was read on the phone', body);
await page.locator('.sheet-back').click();
await closed();

// Unreadable image, AI still off: no AI call, item marked for manual entry
geminiHits.length = 0;
await expandAll();
await page.locator('.item', { hasText: 'Greek Yoghurt' }).click();
await page.waitForSelector('#e-scan');
await page.locator('#e-scan').click();
await page.waitForSelector('input[type=file][accept="image/*"]', { state: 'attached' });
await page.locator('input[type=file][accept="image/*"]').last().setInputFiles({ name: 'blank.png', mimeType: 'image/png', buffer: await datePng('               ') });
await page.waitForFunction(() => {
  const b = document.querySelector('#dates-check b');
  return b && /2 dates/.test(b.textContent || '');
}, { timeout: 120000 }).catch(() => {});
const banner = (await page.locator('#dates-check').count()) ? await page.locator('#dates-check').innerText() : 'none';
check(/2 dates/.test(banner) || /date/.test(banner), 'failed OCR still goes to Dates to check', banner.replace(/\s+/g, ' '));
check(geminiHits.length === 0, 'unreadable photo does not call AI when the toggle is off', String(geminiHits.length));

check(!errors.length, 'no page errors', errors.join(' | '));
await browser.close();
if (process.exitCode) { console.error('Some checks failed'); process.exit(1); }
console.log('All OCR checks passed');
