/**
 * Playwright check for collections, bought-on dates, category editing and the v3 -> v4 data migration.
 * Run against a local preview: BASE=http://127.0.0.1:4173/ node scripts/test-collections.mjs
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

// ---------- 1. Migration: an old (v3) database keeps every item and joins Regular ----------
await page.goto(BASE + '?nosw', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => new Promise(res => { const r = indexedDB.deleteDatabase('pantry'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
await page.goto('about:blank');
await page.goto(BASE + 'manifest.webmanifest');
await page.evaluate(() => new Promise((res, rej) => {
  const r = indexedDB.open('pantry', 3);
  r.onupgradeneeded = () => {
    const db = r.result;
    for (const s of ['items', 'categories', 'shopping', 'events', 'kv', 'expiryJobs', 'purchases']) db.createObjectStore(s, { keyPath: s === 'kv' ? 'key' : 'id' });
    const tx = r.transaction;
    tx.objectStore('categories').put({ id: 'dairy', name: 'Dairy', icon: '🥛', preset: true });
    tx.objectStore('categories').put({ id: 'other', name: 'Other', icon: '📦', preset: true });
    tx.objectStore('items').put({ id: 'old1', name: 'Old Cheese', categoryId: 'dairy', location: 'Fridge', quantity: 2, price: 5, addedAt: 1, status: 'active' });
    tx.objectStore('items').put({ id: 'old2', name: 'Old Butter', categoryId: 'dairy', location: 'Fridge', quantity: 1, addedAt: 2, status: 'used', finishedAt: 3 });
    tx.objectStore('purchases').put({ id: 'p1', itemId: 'old1', name: 'Old Cheese', categoryId: 'dairy', unitPrice: 5, quantity: 2, total: 10, at: Date.now() });
    tx.objectStore('events').put({ id: 'e1', name: 'Old Butter', categoryId: 'dairy', type: 'binned', at: Date.now(), unitPrice: 4, quantity: 1 });
  };
  r.onsuccess = () => { r.result.close(); res(); };
  r.onerror = () => rej(r.error);
}));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.item');
const migrated = await page.evaluate(() => new Promise(res => {
  const r = indexedDB.open('pantry');
  r.onsuccess = () => {
    const db = r.result; const out = { version: db.version };
    const tx = db.transaction(['items', 'purchases', 'events', 'collections', 'categories']);
    const all = n => new Promise(ok => { const q = tx.objectStore(n).getAll(); q.onsuccess = () => ok(q.result); });
    Promise.all(['items', 'purchases', 'events', 'collections', 'categories'].map(all)).then(([items, purchases, events, collections, categories]) => {
      Object.assign(out, { items, purchases, events, collections, categories }); db.close(); res(out);
    });
  };
}));
check(migrated.version === 4, 'database upgraded to v4', `got ${migrated.version}`);
check(migrated.items.length === 2 && migrated.items.every(i => i.collectionId === 'regular' && !i.boughtOn), 'old items kept, moved to Regular, no bought-on date', JSON.stringify(migrated.items));
check(migrated.purchases.every(p => p.collectionId === 'regular') && migrated.events.every(e => e.collectionId === 'regular'), 'old spend and waste history moved to Regular');
check(migrated.collections.some(c => c.id === 'regular' && c.name === 'Regular'), 'Regular collection exists');
check(migrated.categories.length === 2, 'existing categories untouched (no presets re-added)', `got ${migrated.categories.length}`);

// ---------- 2. Demo data: collection filter + grouped view ----------
await page.evaluate(() => new Promise(res => { const r = indexedDB.deleteDatabase('pantry'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
await page.goto(BASE + '?demo', { waitUntil: 'networkidle' });
await page.waitForSelector('.item');
const chips = await page.locator('.col-chips .chip').allInnerTexts();
check(chips.length === 3 && /All/.test(chips[0]) && /Regular/.test(chips[1]) && /Guests/.test(chips[2]), 'collection filter shows All, Regular, Guests', chips.join(' | '));
await page.locator('[data-col="col-guests"]').click();
let names = await page.locator('.item .name').allInnerTexts();
check(names.length === 2 && names.includes('Frozen Prawns 1kg') && names.includes('Sparkling Water 10pk'), 'Guests filter shows only guest items', names.join(', '));
check(await page.locator('.cat-group').count() === 2, 'Guests filter still grouped by category');
await page.locator('[data-col="regular"]').click();
names = await page.locator('.item .name').allInnerTexts();
check(!names.includes('Frozen Prawns 1kg') && names.includes('Greek Yoghurt'), 'Regular filter hides guest items');
await page.locator('[data-col="all"]').click();
const prawnSub = await page.locator('[data-view=list]').click().then(() => page.locator('.item', { hasText: 'Frozen Prawns' }).locator('.sub').innerText());
check(/Guests/.test(prawnSub), 'flat list under All labels non-Regular items with their collection', prawnSub);
await page.locator('[data-view=grouped]').click();

// ---------- 3. Move an item to another collection; set bought-on ----------
await page.locator('.item', { hasText: 'Spaghetti' }).click();
await page.waitForSelector('#e-col');
check(await page.locator('#e-col').inputValue() === 'regular', 'editor shows Regular for an old item');
check(await page.locator('#e-bought').inputValue() === '', 'bought-on is blank by default');
await page.locator('#e-col').selectOption('__new__');
await page.waitForSelector('#col-name');
await page.locator('#col-name').fill('Stocking up');
await page.locator('#col-save').click();
await page.waitForFunction(() => document.querySelectorAll('.sheet-wrap.open').length === 1);
const colVal = await page.locator('#e-col').inputValue();
check(colVal.startsWith('col-'), 'new collection created from the editor and selected', colVal);
await page.locator('#e-bought').fill('2026-11-01');
await page.locator('#e-save').click();
await closed();
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.item');
await page.locator('.col-chips .chip', { hasText: 'Stocking up' }).click();
names = await page.locator('.item .name').allInnerTexts();
check(names.length === 1 && names[0] === 'Spaghetti 500g', 'moved item shows under Stocking up after reload', names.join(', '));
await page.locator('.item', { hasText: 'Spaghetti' }).click();
await page.waitForSelector('#e-bought');
check(await page.locator('#e-bought').inputValue() === '2026-11-01', 'bought-on date saved');
await page.locator('.sheet-back').click();
await closed();

// ---------- 4. Stats per collection ----------
await page.locator('[data-tab=stats]').click();
await page.waitForSelector('.col-stats');
const statText = await page.locator('.col-stat').allInnerTexts();
check(statText.length === 4, 'stats show All + 3 collections', String(statText.length));
const guestsStat = statText.find(t => /Guests/.test(t)) ?? '';
check(/\$39\.00/.test(guestsStat), 'Guests spend is $39.00 (2×7.50 + 24)', guestsStat.replace(/\s+/g, ' '));
const stockStat = statText.find(t => /Stocking up/.test(t)) ?? '';
check(/\$3\.60/.test(stockStat), 'Stocking up spend moved with the item ($3.60)', stockStat.replace(/\s+/g, ' '));
const allStat = statText[0];
check(/Wasted\s*1/.test(allStat) && /Used\s*1/.test(allStat), 'All shows used and wasted counts', allStat.replace(/\s+/g, ' '));

// ---------- 5. Settings: rename and delete built-in categories and collections ----------
await page.locator('[data-tab=settings]').click();
await page.locator('[data-editcat="dairy"]').click();
await page.waitForSelector('#c-name');
await page.locator('#c-name').fill('Milk & Cheese');
await page.locator('#c-save').click();
await closed();
check(/Milk & Cheese/.test(await page.locator('.cats').first().locator('..').locator('..').innerText()) || await page.getByText('Milk & Cheese').count() > 0, 'built-in category renamed');
await page.locator('[data-delcat="produce"]').click();
await page.waitForTimeout(200);
check(await page.locator('[data-delcat="produce"]').count() === 0, 'built-in category Produce deleted');
await page.locator('[data-delcat="other"]').click();
await page.waitForTimeout(200);
check(await page.locator('[data-delcat="other"]').count() === 0, 'Other can be deleted too');
check(await page.locator('[data-delcol="regular"]').count() === 0, 'Regular cannot be deleted');
await page.locator('[data-delcol="col-guests"]').click();
await page.waitForTimeout(200);
check(await page.locator('[data-delcol="col-guests"]').count() === 0, 'Guests collection deleted');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.item');
const groups = await page.locator('.cat-h-name').allInnerTexts();
check(groups.includes('Milk & Cheese') && !groups.includes('Produce'), 'rename and delete persist after reload', groups.join(', '));
check(groups.includes('Uncategorised'), 'spinach from deleted Produce shows under Uncategorised', groups.join(', '));
names = await page.locator('.item .name').allInnerTexts();
check(names.includes('Baby Spinach') && names.includes('Frozen Prawns 1kg'), 'no items lost after deleting categories and a collection');
check(await page.locator('.col-chips .chip', { hasText: 'Guests' }).count() === 0, 'deleted collection gone from filter');
await page.locator('[data-tab=settings]').click();
await page.locator('[data-editcol="regular"]').click();
await page.locator('#col-name').fill('Home');
await page.locator('#col-save').click();
await closed();
check(await page.locator('[data-editcol="regular"]').locator('..').locator('..').innerText().then(t => /Home/.test(t)), 'Regular can be renamed');
await page.locator('[data-editcol="regular"]').click();
await page.locator('#col-name').fill('Regular');
await page.locator('#col-save').click();
await closed();

// ---------- 6. Receipt: purchase date read and collection asked ----------
await page.route(/generativelanguage\.googleapis\.com/, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
  candidates: [{ content: { parts: [{ text: JSON.stringify({ date: '2026-11-14', items: [{ name: 'Party Pies', quantity: 2, categoryId: 'frozen', price: 9 }, { name: 'Lemonade 2L', quantity: 1, categoryId: 'drinks', price: 3 }] }) }] } }],
}) }));
await page.locator('#s-key').fill('AIza-test');
await page.locator('#s-key').dispatchEvent('change');
await page.locator('#fab').click();
await page.locator('[data-a=receipt]').click();
await page.waitForSelector('.cam input[type=file], input[type=file][accept="image/*"]', { state: 'attached' });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
await page.locator('input[type=file][accept="image/*"]').last().setInputFiles({ name: 'r.png', mimeType: 'image/png', buffer: png });
await page.locator('#rp-done').click();
await page.waitForSelector('#rv-date');
check(await page.locator('#rv-date').inputValue() === '2026-11-14', 'receipt purchase date prefilled');
check(await page.locator('#rv-col').inputValue() === 'regular', 'receipt collection defaults to Regular');
await page.locator('#rv-col').selectOption('__new__');
await page.locator('#col-name').fill('Guests – Jan');
await page.locator('#col-save').click();
await page.waitForFunction(() => document.querySelectorAll('.sheet-wrap.open').length === 1);
await page.locator('#rv-add').click();
await closed();
await page.locator('.col-chips .chip', { hasText: 'Guests – Jan' }).click();
names = await page.locator('.item .name').allInnerTexts();
check(names.length === 2 && names.includes('Party Pies'), 'receipt items added to the new collection', names.join(', '));
await page.locator('.item', { hasText: 'Party Pies' }).click();
await page.waitForSelector('#e-bought');
check(await page.locator('#e-bought').inputValue() === '2026-11-14', 'receipt item has the bought-on date');
await page.locator('.sheet-back').click();

// ---------- 7. Manual add: collection defaults to Regular, date blank ----------
await page.locator('#fab').click();
await page.locator('[data-a=manual]').click();
await page.waitForSelector('#e-col');
check(await page.locator('#e-col').inputValue() === 'regular' && await page.locator('#e-bought').inputValue() === '', 'manual add defaults to Regular with no date');

check(!errors.length, 'no page errors', errors.join(' | '));
await browser.close();
if (process.exitCode) { console.error('Some checks failed'); process.exit(1); }
console.log('All collection checks passed');
