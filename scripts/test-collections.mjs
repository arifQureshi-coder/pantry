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

// Leave the app first so it isn't holding the database open while we delete it.
const wipe = async () => { await page.goto(BASE + 'manifest.webmanifest'); await wipeHere(); };
const wipeHere = () => page.evaluate(() => new Promise(res => { const r = indexedDB.deleteDatabase('pantry'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
const readDb = () => page.evaluate(() => new Promise(res => {
  const r = indexedDB.open('pantry');
  r.onsuccess = () => {
    const db = r.result; const out = { version: db.version };
    const names = ['items', 'purchases', 'events', 'collections', 'categories'];
    const tx = db.transaction(names);
    Promise.all(names.map(n => new Promise(ok => { const q = tx.objectStore(n).getAll(); q.onsuccess = () => ok(q.result); }))).then(rows => {
      names.forEach((n, k) => out[n] = rows[k]); db.close(); res(out);
    });
  };
}));
/** Build an old-version database the way an older app release left it. */
const makeOldDb = (version, rows) => page.evaluate(({ version, rows }) => new Promise((res, rej) => {
  const r = indexedDB.open('pantry', version);
  r.onupgradeneeded = () => {
    const stores = ['items', 'categories', 'shopping', 'events', 'kv', 'expiryJobs', 'purchases', ...(version >= 4 ? ['collections'] : [])];
    for (const s of stores) r.result.createObjectStore(s, { keyPath: s === 'kv' ? 'key' : 'id' });
    for (const [s, list] of Object.entries(rows)) for (const row of list) r.transaction.objectStore(s).put(row);
  };
  r.onsuccess = () => { r.result.close(); res(); };
  r.onerror = () => rej(r.error);
}), { version, rows });
const expandAll = async () => { while (await page.locator('.cat-group.closed .cat-h').count()) await page.locator('.cat-group.closed .cat-h').first().click(); };
const now = new Date();
const prev = new Date(now.getFullYear(), now.getMonth() - 1, 10);
const prevISO = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-10`;
const prevKey = prevISO.slice(0, 7);
const prevLabel = prev.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' });
const midday = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d, 12).getTime(); };

// ---------- 1a. Migration from v3 (before collections) ----------
await page.goto(BASE + 'manifest.webmanifest');
await wipe();
await makeOldDb(3, {
  categories: [{ id: 'dairy', name: 'Dairy', icon: '🥛', preset: true }, { id: 'other', name: 'Other', icon: '📦', preset: true }],
  items: [
    { id: 'old1', name: 'Old Cheese', categoryId: 'dairy', location: 'Fridge', quantity: 2, price: 5, addedAt: 1000, status: 'active' },
    { id: 'old2', name: 'Old Butter', categoryId: 'dairy', location: 'Fridge', quantity: 1, addedAt: 2000, status: 'used', finishedAt: 3000 },
  ],
  purchases: [{ id: 'p1', itemId: 'old1', name: 'Old Cheese', categoryId: 'dairy', unitPrice: 5, quantity: 2, total: 10, at: Date.now() }],
  events: [
    { id: 'e1', name: 'Old Butter', categoryId: 'dairy', type: 'binned', at: 5000, unitPrice: 4, quantity: 1 },
    { id: 'e2', name: 'Long Gone Bread', categoryId: 'other', type: 'used', at: 6000, quantity: 1 },
  ],
});
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.tile');
let m = await readDb();
check(m.version === 5, 'v3 database upgraded to v5', `got ${m.version}`);
check(m.items.length === 2 && m.items.every(i => i.collectionId === 'regular' && !i.boughtOn), 'old items kept, moved to Regular, no bought-on date');
check(m.purchases.every(p => p.collectionId === 'regular') && m.events.every(e => e.collectionId === 'regular'), 'old spend and waste history moved to Regular');
check(m.collections.some(c => c.id === 'regular' && c.name === 'Regular'), 'Regular collection exists');
check(m.categories.length === 2, 'existing categories untouched (no presets re-added)', `got ${m.categories.length}`);
check(m.purchases[0].boughtAt === 1000, 'old purchase gets its item\'s added date as bought date', m.purchases[0].boughtAt);
const e1 = m.events.find(e => e.id === 'e1'), e2 = m.events.find(e => e.id === 'e2');
check(e1.itemId === 'old2' && e1.boughtAt === 2000, 'old binned record linked to its item by name and dated by it', JSON.stringify(e1));
check(!e2.itemId && e2.boughtAt === 6000, 'unlinked old record falls back to its own date', JSON.stringify(e2));

// ---------- 1b. Migration from v4 (the live version on the phone) ----------
await wipe();
await makeOldDb(4, {
  categories: [{ id: 'dairy', name: 'Dairy', icon: '🥛', preset: true }],
  collections: [{ id: 'regular', name: 'Regular', builtin: true, createdAt: 0 }, { id: 'col-x', name: 'Guests', createdAt: 1 }],
  kv: [{ key: 'catsSeeded', value: true }, { key: 'settings', value: { provider: 'gemini', geminiKey: '', geminiModel: 'gemini-3.6-flash', openaiKey: '', openaiModel: 'gpt-4o-mini', leadDays: 3, view: 'grouped' } }],
  items: [{ id: 'i4', name: 'Brie', categoryId: 'dairy', collectionId: 'col-x', location: 'Fridge', quantity: 1, price: 8, boughtOn: prevISO, addedAt: Date.now(), status: 'active' }],
  purchases: [{ id: 'p4', itemId: 'i4', name: 'Brie', categoryId: 'dairy', collectionId: 'col-x', unitPrice: 8, quantity: 1, total: 8, at: Date.now() }],
  events: [{ id: 'e4', itemId: 'i4', name: 'Brie', categoryId: 'dairy', collectionId: 'col-x', type: 'used', at: Date.now(), unitPrice: 8, quantity: 1 }],
});
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.tile');
m = await readDb();
check(m.version === 5 && m.items.length === 1 && m.collections.length === 2, 'v4 database upgraded to v5 with items and collections kept');
check(m.purchases[0].boughtAt === midday(prevISO) && m.events[0].boughtAt === midday(prevISO), 'v4 records dated by the item\'s bought-on date');
check(await page.locator('[data-view=grid].on').count() === 1, 'old saved "grouped" view setting now opens on Grid');

// ---------- 2. Demo data: views, collection dropdown ----------
await wipe();
await page.goto(BASE + '?demo', { waitUntil: 'networkidle' });
await page.waitForSelector('.tile');
check(await page.locator('#col-filter').inputValue() === 'all', 'collection dropdown defaults to All collections');
const colOpts = await page.locator('#col-filter option').allInnerTexts();
check(colOpts.join('|') === 'All collections|Regular|Guests – Dec', 'dropdown lists All collections plus every collection', colOpts.join('|'));
check(await page.locator('.col-chips').count() === 0, 'old collection button row is gone');
await page.locator('#col-filter').selectOption('col-guests');
const tiles = await page.locator('.tile .tile-name').allInnerTexts();
check(tiles.length === 2 && tiles.includes('Drinks') && tiles.includes('Frozen'), 'grid follows the collection dropdown', tiles.join(', '));
await page.locator('[data-view=list]').click();
await page.waitForSelector('.cat-group');
check(await page.locator('.cat-group').count() === 2 && await page.locator('.cat-group.closed').count() === 2, 'List groups guest items with headers folded');
await expandAll();
let names = await page.locator('.item .name').allInnerTexts();
check(names.length === 2 && names.includes('Frozen Prawns 1kg') && names.includes('Sparkling Water 10pk'), 'Guests shows only guest items', names.join(', '));
await page.locator('#col-filter').selectOption('regular');
await expandAll();
names = await page.locator('.item .name').allInnerTexts();
check(!names.includes('Frozen Prawns 1kg') && names.includes('Greek Yoghurt'), 'Regular hides guest items');
await page.locator('#col-filter').selectOption('all');
await expandAll();
const prawnSub = await page.locator('.item', { hasText: 'Frozen Prawns' }).locator('.sub').innerText();
check(/Guests/.test(prawnSub), 'under All collections, non-Regular items show their collection', prawnSub);

// ---------- 3. Move an item to another collection, bought last month ----------
await page.locator('.item', { hasText: 'Spaghetti' }).click();
await page.waitForSelector('#e-col');
check(await page.locator('#e-col').inputValue() === 'regular', 'editor shows Regular');
check(await page.locator('#e-bought').count() === 1, 'editor has a bought-on field');
await page.locator('#e-col').selectOption('__new__');
await page.waitForSelector('#col-name');
await page.locator('#col-name').fill('Stocking up');
await page.locator('#col-save').click();
await page.waitForFunction(() => document.querySelectorAll('.sheet-wrap.open').length === 1);
const stockId = await page.locator('#e-col').inputValue();
check(stockId.startsWith('col-'), 'new collection created from the editor and selected', stockId);
await page.locator('#e-bought').fill(prevISO);
await page.locator('#e-save').click();
await closed();
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.cat-group');
await page.locator('#col-filter').selectOption(stockId);
await expandAll();
names = await page.locator('.item .name').allInnerTexts();
check(names.length === 1 && names[0] === 'Spaghetti 500g', 'moved item shows under Stocking up after reload', names.join(', '));
await page.locator('.item', { hasText: 'Spaghetti' }).click();
await page.waitForSelector('#e-used');
check(await page.locator('#e-bought').inputValue() === prevISO, 'bought-on date saved');
await page.locator('#e-used').click(); // use 1 of 2 today; it still counts toward last month's groceries
await closed();

// ---------- 4. Stats: one set of figures for Collection + Category + Period ----------
await page.locator('[data-tab=stats]').click();
await page.waitForSelector('#st-period');
check(await page.locator('.col-stats').count() === 0, 'stacked per-collection sections removed');
check(await page.locator('#st-col').inputValue() === 'all' && await page.locator('#st-cat').inputValue() === 'all' && await page.locator('#st-period').inputValue() === 'all', 'stats dropdowns default to All / All / All time');
const periods = await page.locator('#st-period option').allInnerTexts();
check(periods.slice(0, 4).join('|') === 'This week|This month|Last month|Last 3 months' && periods.includes(prevLabel) && periods.slice(-2).join('|') === 'All time|Custom…', 'period options: week, month, last month, last 3 months, earlier months, all time, custom', periods.join('|'));
const spent = () => page.locator('#st-spent').innerText();
const cardOf = label => page.locator('#st-cards .card', { hasText: label }).innerText().then(t => t.replace(/\s+/g, ' '));
await page.locator('#st-col').selectOption('col-guests');
check(await spent() === '$39.00', 'Guests spend is $39.00 (2×7.50 + 24)', await spent());
await page.locator('#st-col').selectOption(stockId);
await page.locator('#st-period').selectOption(prevKey);
check(await spent() === '$3.60', 'Stocking up, last month: spend $3.60 by bought-on date', await spent());
check(/^1 Used \$1\.80/.test(await cardOf('Used')), 'used today but counted in last month (bought then)', await cardOf('Used'));
check(/^1 Still in stock \$1\.80/.test(await cardOf('Still in stock')), 'still in stock: 1 item worth $1.80', await cardOf('Still in stock'));
await page.locator('#st-period').selectOption('month');
check(await spent() === '$0.00' && /^0 Used/.test(await cardOf('Used')), 'This month excludes groceries bought last month', `${await spent()} / ${await cardOf('Used')}`);
await page.locator('#st-period').selectOption('lastmonth');
check(await spent() === '$3.60', 'Last month includes groceries bought last month', await spent());
await page.locator('#st-period').selectOption('3m');
check(await spent() === '$3.60', 'Last 3 months includes them too', await spent());
await page.locator('#st-period').selectOption('custom');
await page.locator('#st-from').fill(prevISO); await page.locator('#st-from').dispatchEvent('change');
await page.locator('#st-to').fill(prevISO); await page.locator('#st-to').dispatchEvent('change');
check(await spent() === '$3.60', 'Custom range is inclusive of its start and end day', await spent());
const nextDay = `${prevKey}-11`;
await page.locator('#st-from').fill(nextDay); await page.locator('#st-from').dispatchEvent('change');
await page.locator('#st-to').fill(nextDay); await page.locator('#st-to').dispatchEvent('change');
check(await spent() === '$0.00', 'Custom range excludes other days', await spent());
await page.locator('#st-col').selectOption('all');
await page.locator('#st-cat').selectOption('frozen');
await page.locator('#st-period').selectOption('all');
check(await spent() === '$27.80', 'All collections + Frozen + All time = $27.80 (peas 3.80 + prawns 24)', await spent());
await page.locator('#st-col').selectOption('col-guests');
check(await spent() === '$24.00', 'Guests + Frozen = $24.00', await spent());
await page.locator('#st-col').selectOption('all');
await page.locator('#st-cat').selectOption('all');
check(/^1 Wasted \$3\.50/.test(await cardOf('Wasted')) && /^2 Used/.test(await cardOf('Used')), 'All: wasted 1 ($3.50), used 2', `${await cardOf('Wasted')} / ${await cardOf('Used')}`);
check(/^1 Expired/.test(await cardOf('Expired')), 'expired count shown', await cardOf('Expired'));
check(await page.locator('.spend-list li').count() >= 5, 'by-category breakdown follows the filters');

// ---------- 4b. Clear pantry: items + spend + used/binned history ----------
await page.locator('[data-tab=items]').click();
await page.locator('#col-filter').selectOption(stockId);
await page.locator('#clear-pantry').click();
await page.waitForSelector('#clear-yes');
const warn = await page.locator('.warn-box').innerText();
check(/1 item/.test(warn) && /Stocking up/.test(warn) && !/in total|quantity/.test(warn), 'clear confirm states the count and scope', warn.replace(/\s+/g, ' '));
await page.locator('#clear-yes').click();
await closed();
m = await readDb();
const spagId = m.items.find(i => /Spaghetti/.test(i.name))?.id;
check(!spagId && !m.purchases.some(p => /Spaghetti/.test(p.name)) && !m.events.some(e => /Spaghetti/.test(e.name)), 'cleared item, its purchases and its used history are deleted');
check(m.items.length === 10, 'other items untouched', `${m.items.length} left`);
await page.locator('#col-filter').selectOption('all');
await page.locator('#q').fill('Tim');
check(/Clear pantry \(1\)/.test(await page.locator('#clear-pantry').innerText()), 'clear follows the search', await page.locator('#clear-pantry').innerText());
await page.locator('#clear-pantry').click();
await page.locator('#clear-yes').click();
await closed();
await page.locator('#q').fill('');
m = await readDb();
check(m.items.length === 9 && !m.items.some(i => /Tim Tams/.test(i.name)), 'search-scoped clear deleted just Tim Tams');
await page.locator('[data-tab=stats]').click();
await page.waitForSelector('#st-spent');
check(await spent() === '$76.10', 'Stats total drops after clearing ($84.20 − 3.60 − 4.50)', await spent());

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
await page.waitForSelector('.cat-group');
await expandAll();
const groups = await page.locator('.cat-h-name').allInnerTexts();
check(groups.includes('Milk & Cheese') && !groups.includes('Produce'), 'rename and delete persist after reload', groups.join(', '));
check(groups.includes('Uncategorised'), 'spinach from deleted Produce shows under Uncategorised', groups.join(', '));
names = await page.locator('.item .name').allInnerTexts();
check(names.includes('Baby Spinach') && names.includes('Frozen Prawns 1kg'), 'no items lost after deleting categories and a collection');
check(!(await page.locator('#col-filter option').allInnerTexts()).some(t => /Guests/.test(t)), 'deleted collection gone from the dropdown');
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
await page.locator('#col-filter').selectOption({ label: 'Guests – Jan' });
await expandAll();
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

// ---------- 8. Dates to check: No expiry / clearing / setting a date removes the item ----------
await wipe();
await page.goto(BASE + '?demo&shot=dates', { waitUntil: 'networkidle' });
await page.waitForSelector('.tile');
const toCheck = async () => (await page.locator('#dates-check').count()) ? (await page.locator('#dates-check b').innerText()) : 'none';
check(await toCheck() === '3 dates to check', 'three dates to check to start', await toCheck());
await page.locator('[data-view=list]').click(); await page.waitForSelector('.cat-group'); await expandAll();
await page.locator('.item', { hasText: 'Baby Spinach' }).click(); await page.locator('#e-clear').click(); await page.locator('#e-save').click(); await closed();
check(await toCheck() === '2 dates to check', 'clearing a suggested date removes it from Dates to check', await toCheck());
await page.locator('.item', { hasText: 'Greek Yoghurt' }).click(); await page.locator('#e-clear').click(); await page.locator('#e-save').click(); await closed();
check(await toCheck() === '1 date to check', 'clearing an unreadable date removes it too', await toCheck());
await page.locator('#dates-check').click(); await page.waitForSelector('[data-noexp]');
await page.locator('[data-noexp]').first().click();
await closed();
check(await toCheck() === 'none', '"No expiry" in Dates to check removes the last one', await toCheck());

// ---------- 9. Multi-select: change category, No expiry, delete ----------
await wipe();
await page.goto(BASE + '?demo&shot=dates', { waitUntil: 'networkidle' });
await page.waitForSelector('.tile');
await page.locator('#sel-btn').click();
await page.waitForSelector('#sel-bar');
check(await page.locator('.cat-group.closed').count() === 0 && await page.locator('.item .sel-check').count() === 11, 'Select from Grid shows every item with a tick box');
await page.locator('.item', { hasText: 'Chicken Thighs' }).click();
await page.locator('.item', { hasText: 'Sourdough' }).click();
check(/2 selected/.test(await page.locator('#sel-bar').innerText()), 'two selected');
await page.locator('#sel-cat').click();
await page.waitForSelector('.cat-row');
await page.locator('.cat-row[data-c="snacks"]').click();
await page.waitForSelector('#sel-bar', { state: 'detached' });
m = await readDb();
check(['Chicken Thighs 500g', 'Sourdough Loaf'].every(n => m.items.find(i => i.name === n)?.categoryId === 'snacks'), 'bulk category change moved both to Snacks');
check(m.purchases.filter(p => /Chicken|Sourdough/.test(p.name)).every(p => p.categoryId === 'snacks'), 'their spend moved category too');
await page.locator('#sel-btn').click();
for (const n of ['Greek Yoghurt', 'Full Cream Milk', 'Baby Spinach']) await page.locator('.item', { hasText: n }).click();
await page.locator('#sel-noexp').click();
await page.waitForSelector('#sel-bar', { state: 'detached' });
m = await readDb();
check(['Greek Yoghurt', 'Full Cream Milk 2L', 'Baby Spinach'].every(n => { const i = m.items.find(x => x.name === n); return i.noExpiry && !i.expiry && !i.expiryStatus; }), 'bulk No expiry set on all three, dates cleared');
check(await toCheck() === 'none', 'bulk No expiry cleared Dates to check', await toCheck());
await page.locator('#sel-btn').click();
await page.locator('.item', { hasText: 'Tim Tams' }).click();
await page.locator('.item', { hasText: 'Spaghetti' }).click();
await page.locator('#sel-del').click();
await page.waitForSelector('#sel-bar', { state: 'detached' });
m = await readDb();
check(m.items.length === 9 && !m.items.some(i => /Tim Tams|Spaghetti/.test(i.name)), 'bulk delete removed the two selected items', String(m.items.length));
check(m.purchases.some(p => /Tim Tams/.test(p.name)), 'bulk delete keeps spend history, like single delete');

// ---------- 10. Shopping list by collection ----------
await page.locator('[data-view=list]').click(); await page.waitForSelector('.cat-group');
await expandAll();
await page.locator('.item', { hasText: 'Frozen Prawns' }).click();
await page.locator('#e-used').click();
await closed();
m = await page.evaluate(() => new Promise(res => { const r = indexedDB.open('pantry'); r.onsuccess = () => { const q = r.result.transaction('shopping').objectStore('shopping').getAll(); q.onsuccess = () => { r.result.close(); res(q.result); }; }; }));
const prawnShop = m.find(x => /Prawns/.test(x.name));
check(prawnShop?.collectionId === 'col-guests', 'used-up guest item lands on the shopping list under Guests', JSON.stringify(prawnShop));
await page.locator('[data-tab=shopping]').click();
await page.waitForSelector('#shop-col');
check(await page.locator('#shop-col').inputValue() === 'all', 'shopping dropdown defaults to All collections');
const heads = await page.locator('.shop-group h3').allInnerTexts();
check(heads.length === 2 && /Regular/i.test(heads[0]) && /Guests/i.test(heads[1]), 'shopping list grouped by collection (old items under Regular)', heads.join(' | '));
await page.locator('#shop-col').selectOption('col-guests');
let shopNames = await page.locator('.shop .name').allInnerTexts();
check(shopNames.length === 1 && /Prawns/.test(shopNames[0]), 'Guests shows only its shopping items', shopNames.join(', '));
await page.locator('#shop-in').fill('Napkins'); await page.locator('#shop-in').press('Enter');
await page.locator('#shop-col').selectOption('all');
await page.locator('#shop-in').fill('Bread'); await page.locator('#shop-in').press('Enter');
m = await page.evaluate(() => new Promise(res => { const r = indexedDB.open('pantry'); r.onsuccess = () => { const q = r.result.transaction('shopping').objectStore('shopping').getAll(); q.onsuccess = () => { r.result.close(); res(q.result); }; }; }));
check(m.find(x => x.name === 'Napkins')?.collectionId === 'col-guests' && m.find(x => x.name === 'Bread')?.collectionId === 'regular', 'manual adds go to the picked collection, or Regular under All');

// ---------- 11. App-wide search ----------
await page.locator('[data-tab=items]').click();
await page.locator('#col-filter').selectOption('regular'); // search still looks everywhere
await page.locator('#q').fill('frozen');
const results = (await page.locator('#search-results .item').allInnerTexts()).map(t => t.replace(/\s+/g, ' '));
check(results.some(t => /Frozen Peas 1kg Frozen · Regular/.test(t)), 'search shows category and collection', results.join(' | '));
await page.locator('#q').fill('napkin');
const shopHit = (await page.locator('#search-results .item').allInnerTexts()).map(t => t.replace(/\s+/g, ' '));
check(shopHit.length === 1 && /Shopping list · Guests/.test(shopHit[0]), 'search finds shopping items, labelled as such', shopHit.join(' | '));
await page.locator('#q').fill('sparkling');
check(await page.locator('[data-jump-item]').count() === 1, 'search finds items in other collections than the one picked');
await page.locator('[data-jump-item]').click();
await page.waitForSelector('.item.flash');
check(await page.locator('#col-filter').inputValue() === 'all' && /Sparkling/.test(await page.locator('.item.flash').innerText()), 'tapping a result opens the List at that item and highlights it');
await page.locator('#q').fill('napkin');
await page.locator('[data-jump-shop]').click();
await page.waitForSelector('[data-sid].flash');
check(/Napkins/.test(await page.locator('[data-sid].flash').innerText()), 'tapping a shopping result opens the shopping list at it');

check(!errors.length, 'no page errors', errors.join(' | '));
await browser.close();
if (process.exitCode) { console.error('Some checks failed'); process.exit(1); }
console.log('All collection checks passed');
