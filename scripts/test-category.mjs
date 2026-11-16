/**
 * Playwright check: change an item's category, reload, and confirm
 * the list, grid, filter and editor all show the new category.
 * Run against a local preview: BASE=http://127.0.0.1:4173 node scripts/test-category.mjs
 */
import { createRequire } from 'node:module';
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

const browser = await chromium.launch({ executablePath: process.env.CHROME || ((await import('node:fs')).existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : undefined), headless: true });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: UA, locale: 'en-AU', timezoneId: 'Australia/Sydney',
});
const page = await ctx.newPage();

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => new Promise((res, rej) => {
  const r = indexedDB.deleteDatabase('pantry');
  r.onsuccess = r.onerror = r.onblocked = () => res();
}));
await page.goto(BASE + '?demo', { waitUntil: 'networkidle' });
await page.waitForSelector('.item');

if (!await page.locator('.cat-group').count()) fail('default view should be grouped by category');
else pass('default view is grouped by category');

const groupOf = name => page.locator('.cat-group', { has: page.locator('.item', { hasText: name }) }).locator('.cat-h-name');
const yog = page.locator('.item', { hasText: 'Greek Yoghurt' });
await yog.waitFor();
const before = await groupOf('Greek Yoghurt').innerText();
if (!/\bDairy\b/.test(before)) fail(`Yoghurt should be in the Dairy group, got "${before}"`);
else pass(`grouped under Dairy before change (${before})`);

await yog.click();
await page.waitForSelector('.sheet-wrap.open #e-cats');
await page.locator('#e-cats .chip', { hasText: 'Snacks' }).click();
await page.locator('#e-save').click();
await page.waitForSelector('.sheet-wrap.open', { state: 'detached' });
await page.waitForTimeout(300);

const afterSave = await groupOf('Greek Yoghurt').innerText();
if (!/\bSnacks\b/.test(afterSave)) fail(`Yoghurt should be in the Snacks group after save, got "${afterSave}"`);
else pass(`grouped under Snacks after save (${afterSave})`);

await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.item');

const afterReload = await groupOf('Greek Yoghurt').innerText();
if (!/\bSnacks\b/.test(afterReload)) fail(`Yoghurt should be in the Snacks group after reload, got "${afterReload}"`);
else pass(`grouped under Snacks after reload (${afterReload})`);

await page.locator('[data-view=grid]').click();
await page.waitForSelector('.tile');
const snacksTile = page.locator('.tile', { hasText: 'Snacks' });
const dairyTile = page.locator('.tile', { hasText: 'Dairy' });
const snacksText = await snacksTile.innerText();
const dairyText = await dairyTile.innerText();
if (!/2 item/.test(snacksText)) fail(`Snacks grid count should be 2, got "${snacksText.replace(/\s+/g, ' ')}"`);
else pass(`grid Snacks count is 2`);
if (!/1 item/.test(dairyText)) fail(`Dairy grid count should be 1, got "${dairyText.replace(/\s+/g, ' ')}"`);
else pass(`grid Dairy count is 1`);

await page.locator('[data-view=list]').click();
await page.waitForSelector('.item');
const flatSub = await page.locator('.item', { hasText: 'Greek Yoghurt' }).locator('.sub').innerText();
if (!/\bSnacks\b/.test(flatSub)) fail(`flat list should show Snacks, got "${flatSub}"`);
else pass(`flat list shows Snacks (${flatSub})`);

await page.locator('#filter-btn').click();
await page.waitForSelector('.sheet-wrap.open');
await page.locator('[data-cat="snacks"]').click();
await page.locator('#f-apply').click();
await page.waitForSelector('.sheet-wrap.open', { state: 'detached' });
const filtered = await page.locator('.item .name').allInnerTexts();
if (!filtered.includes('Greek Yoghurt')) fail(`Snacks filter missing Greek Yoghurt: ${filtered.join(', ')}`);
else pass(`filter by Snacks includes Greek Yoghurt`);
if (filtered.includes('Full Cream Milk 2L')) fail('Snacks filter should not include milk');
else pass('filter by Snacks excludes milk');

await page.locator('.item', { hasText: 'Greek Yoghurt' }).click();
await page.waitForSelector('.sheet-wrap.open #e-cats');
const on = await page.locator('#e-cats .chip.on').innerText();
if (!/Snacks/.test(on)) fail(`editor should have Snacks selected, got "${on}"`);
else pass(`editor shows Snacks selected (${on})`);
await page.locator('.sheet-back').click();
await page.waitForSelector('.sheet-wrap.open', { state: 'detached' });

// Bonus: No expiry — mark milk, reload, check pill, filter, and that No date does not include it.
await page.locator('#filter-btn').click();
await page.waitForSelector('#f-clear');
await page.locator('#f-clear').click();
await page.locator('#f-apply').click();
await page.waitForSelector('.sheet-wrap.open', { state: 'detached' });
await page.locator('.item', { hasText: 'Full Cream Milk' }).click();
await page.waitForSelector('#e-noexp');
await page.locator('#e-noexp').check();
await page.locator('#e-save').click();
await page.waitForSelector('.sheet-wrap.open', { state: 'detached' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.item');
const milkPill = await page.locator('.item', { hasText: 'Full Cream Milk' }).locator('.pill').innerText();
if (!/No expiry/.test(milkPill) || /No date/.test(milkPill)) fail(`milk pill should be No expiry, got "${milkPill}"`);
else pass(`milk pill is "${milkPill.trim()}" after reload`);
await page.locator('#filter-btn').click();
await page.waitForSelector('.sheet-wrap.open');
const noExpChip = await page.locator('[data-status=noexpiry]').innerText();
const noDateChip = await page.locator('[data-status=none]').innerText();
if (!/\b1\b/.test(noExpChip)) fail(`No expiry filter count should be 1, got "${noExpChip}"`);
else pass(`No expiry filter count is 1`);
// Demo has no other undated items, so No date should be 0
if (!/\b0\b/.test(noDateChip)) fail(`No date should not include no-expiry items, got "${noDateChip}"`);
else pass(`No date count excludes no-expiry items (${noDateChip.replace(/\s+/g, ' ')})`);

await browser.close();
if (process.exitCode) {
  console.error('Some checks failed');
  process.exit(1);
}
console.log('All category (and no-expiry) checks passed');
