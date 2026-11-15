import './style.css';
import type { Item, Category, ShopItem, Settings, Location, WasteEvent } from './types';
import * as db from './db';
import { guessCategory, defaultLocation, ICON_CHOICES } from './categories';
import { daysUntil, formatDate, parseExpiry } from './dates';
import { lookupBarcode } from './off';
import { askAI, extractReceipt, readExpiry, suggestCategory, fileToJpeg, hasKey } from './ai';
// Camera/barcode code (~400 KB) is loaded only when first needed.
const scanner = () => import('./scanner');

// ---------- state ----------
type Tab = 'items' | 'shopping' | 'stats' | 'settings';
type StatusFilter = 'all' | 'soon' | 'expired' | 'fresh' | 'none' | 'attention';
const S = {
  tab: 'items' as Tab,
  items: [] as Item[], cats: [] as Category[], shop: [] as ShopItem[], events: [] as WasteEvent[],
  settings: db.DEFAULT_SETTINGS as Settings,
  q: '', cat: 'all', loc: 'all' as 'all' | Location, sort: 'expiry' as 'expiry' | 'name' | 'added', view: 'list' as 'list' | 'grid',
  status: 'all' as StatusFilter,
};
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const localDate = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const catOf = (id: string) => S.cats.find(c => c.id === id) ?? { id: 'other', name: 'Other', icon: '📦' };
const active = () => S.items.filter(i => i.status === 'active');

async function load() {
  S.cats = await db.ensureCategories();
  [S.items, S.shop, S.events, S.settings] = await Promise.all([db.getAll<Item>('items'), db.getAll<ShopItem>('shopping'), db.getAll<WasteEvent>('events'), db.getSettings()]);
}

// ---------- expiry helpers ----------
type Fresh = 'fresh' | 'soon' | 'expired' | 'none';
function freshness(i: Item): Fresh {
  if (!i.expiry) return 'none';
  const d = daysUntil(i.expiry);
  return d < 0 ? 'expired' : d <= S.settings.leadDays ? 'soon' : 'fresh';
}
function expiryLabel(i: Item) {
  if (!i.expiry) return 'No date';
  const d = daysUntil(i.expiry);
  if (d < 0) return d === -1 ? 'Expired yesterday' : `Expired ${-d}d ago`;
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d <= 30) return `${d} days`;
  return i.expiryMonthOnly ? localDate(i.expiry).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' }) : formatDate(i.expiry);
}
const expiringSoon = () => active().filter(i => ['soon', 'expired'].includes(freshness(i))).sort((a, b) => a.expiry!.localeCompare(b.expiry!));

// ---------- toast / sheet ----------
function toast(msg: string) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2400);
}
function sheet(html: string, opts: { full?: boolean } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet ${opts.full ? 'full' : ''}"><div class="grabber"></div>${html}</div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  const close = () => { wrap.classList.remove('open'); setTimeout(() => wrap.remove(), 250); };
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  wrap.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  return { el: wrap.querySelector('.sheet') as HTMLElement, close };
}
function busy(msg: string) {
  const el = document.createElement('div'); el.className = 'busy';
  el.innerHTML = `<div class="spinner"></div><p>${esc(msg)}</p>`;
  document.body.appendChild(el);
  return () => el.remove();
}

// ---------- render ----------
function render() {
  const app = $('#app');
  app.innerHTML = `
    <main class="page">${S.tab === 'items' ? itemsView() : S.tab === 'shopping' ? shoppingView() : S.tab === 'stats' ? statsView() : settingsView()}</main>
    <nav class="tabbar">
      ${tabBtn('items', '🏠', 'Items')}${tabBtn('shopping', '🛒', 'List', S.shop.filter(s => !s.done).length)}
      <button class="fab" id="fab" aria-label="Add item">＋</button>
      ${tabBtn('stats', '📊', 'Stats')}${tabBtn('settings', '⚙️', 'Settings')}
    </nav>`;
  app.querySelectorAll<HTMLElement>('[data-tab]').forEach(b => b.onclick = () => { S.tab = b.dataset.tab as Tab; render(); window.scrollTo(0, 0); });
  $('#fab').onclick = addMenu;
  ({ items: bindItems, shopping: bindShopping, stats: bindStats, settings: bindSettings })[S.tab]();
}
const tabBtn = (t: Tab, icon: string, label: string, badge = 0) =>
  `<button class="tab ${S.tab === t ? 'on' : ''}" data-tab="${t}"><span class="ti">${icon}${badge ? `<b class="badge">${badge}</b>` : ''}</span><span>${label}</span></button>`;

function itemsView() {
  const soon = expiringSoon();
  const n = activeFilterCount();
  return `
    <header class="hdr"><h1>Pantry</h1>
      <div class="seg small" role="tablist">
        <button data-view="list" class="${S.view === 'list' ? 'on' : ''}" aria-label="List view">☰</button>
        <button data-view="grid" class="${S.view === 'grid' ? 'on' : ''}" aria-label="Category view">▦</button>
      </div>
    </header>
    ${soon.length ? `<button class="banner ${soon.some(i => freshness(i) === 'expired') ? 'red' : ''}" id="soon">
        <span>⏰</span><span><b>${soon.length} item${soon.length > 1 ? 's' : ''} expiring soon</b><br><small>${esc(soon.slice(0, 3).map(i => i.name).join(', '))}${soon.length > 3 ? '…' : ''}</small></span><span>›</span></button>` : ''}
    <div class="search"><span>🔎</span><input id="q" type="search" placeholder="Search items" value="${esc(S.q)}" autocomplete="off"></div>
    <div class="row-between">
      <button class="btn-filter ${n ? 'on' : ''}" id="filter-btn" aria-label="${n ? `Filter, ${n} active` : 'Filter'}">Filter${n ? `<b class="fbadge">${n}</b>` : ''}</button>
      <select id="sort" class="sort" aria-label="Sort">
        <option value="expiry" ${S.sort === 'expiry' ? 'selected' : ''}>⇅ Expiry</option>
        <option value="name" ${S.sort === 'name' ? 'selected' : ''}>⇅ A–Z</option>
        <option value="added" ${S.sort === 'added' ? 'selected' : ''}>⇅ Newest</option>
      </select>
    </div>
    ${activeFilterChips()}
    <div id="results">${resultsHtml()}</div>`;
}
function resultsHtml() {
  const list = filtered();
  if (S.view === 'grid' && S.cat === 'all' && !S.q) return gridView();
  return list.length ? `<ul class="list">${list.map(itemRow).join('')}</ul>` : emptyState();
}
function gridView() {
  const counts = S.cats.map(c => {
    const its = itemsMatching({ cat: c.id });
    return { c, n: its.length, alert: its.some(i => ['soon', 'expired'].includes(freshness(i))) };
  }).filter(x => x.n);
  if (!counts.length) return emptyState();
  return `<div class="grid">${counts.map(({ c, n, alert }) => `
    <button class="tile" data-cat="${c.id}">${alert ? '<i class="dot"></i>' : ''}<span class="tile-icon">${c.icon}</span><span class="tile-name">${esc(c.name)}</span><span class="tile-n">${n} item${n > 1 ? 's' : ''}</span></button>`).join('')}</div>`;
}

function emptyState() {
  if (!active().length) return `<div class="empty"><div class="empty-icon">🧺</div><h3>Your pantry is empty</h3><p>Tap <b>＋</b> to scan a barcode or a receipt.</p></div>`;
  const copy: Record<StatusFilter, { icon: string; title: string; body: string }> = {
    all: { icon: '🔎', title: 'No matching items', body: 'Try a different search or filter.' },
    soon: { icon: '⏰', title: 'No items expiring soon', body: 'Nothing is due within your reminder window.' },
    expired: { icon: '⚠️', title: 'No expired items', body: 'Nothing in your pantry is past its date.' },
    fresh: { icon: '✨', title: 'No fresh items', body: 'Nothing currently matches this filter.' },
    none: { icon: '📅', title: 'No items without a date', body: 'Every item here has an expiry date.' },
    attention: { icon: '✅', title: 'Nothing needs attention', body: 'No items are expired or expiring soon.' },
  };
  const m = copy[S.status];
  const narrowed = S.q || S.cat !== 'all' || S.loc !== 'all';
  return `<div class="empty"><div class="empty-icon">${m.icon}</div><h3>${m.title}</h3><p>${narrowed && S.status !== 'all' ? 'Try clearing search, category or location.' : m.body}</p></div>`;
}
function itemRow(i: Item) {
  const c = catOf(i.categoryId); const f = freshness(i);
  return `<li class="item" data-id="${i.id}">
    <div class="thumb">${i.image ? `<img src="${esc(i.image)}" alt="" loading="lazy" onerror="this.replaceWith(document.createTextNode('${c.icon}'))">` : c.icon}</div>
    <div class="meta"><div class="name">${esc(i.name)}</div><div class="sub">${esc(i.location)}${i.quantity > 1 ? ` · ×${i.quantity}` : ''}${i.opened ? ' · opened' : ''}</div></div>
    <span class="pill ${f}">${expiryLabel(i)}</span></li>`;
}
const STATUS_CHIPS: [StatusFilter, string, string][] = [
  ['all', 'All', ''],
  ['soon', 'Expiring soon', 'soon'],
  ['expired', 'Expired', 'expired'],
  ['fresh', 'Fresh', 'fresh'],
  ['none', 'No date', 'none'],
];
const STATUS_LABEL: Record<StatusFilter, string> = {
  all: 'All', soon: 'Expiring soon', expired: 'Expired', fresh: 'Fresh', none: 'No date', attention: 'Needs attention',
};
type FilterSet = { status: StatusFilter; cat: string; loc: 'all' | Location; q: string };
const currentFilters = (): FilterSet => ({ status: S.status, cat: S.cat, loc: S.loc, q: S.q });
function activeFilterCount(f: FilterSet = currentFilters()) {
  return (f.status !== 'all' ? 1 : 0) + (f.cat !== 'all' ? 1 : 0) + (f.loc !== 'all' ? 1 : 0);
}
function itemsMatching(over: Partial<FilterSet> = {}) {
  const f = { ...currentFilters(), ...over };
  const q = f.q.trim().toLowerCase();
  return active().filter(i => (f.cat === 'all' || i.categoryId === f.cat) && (f.loc === 'all' || i.location === f.loc) &&
    (!q || `${i.name} ${i.brand ?? ''} ${catOf(i.categoryId).name}`.toLowerCase().includes(q)) &&
    matchesStatus(i, f.status));
}
function matchesStatus(i: Item, status: StatusFilter = S.status) {
  const f = freshness(i);
  if (status === 'all') return true;
  if (status === 'attention') return f === 'soon' || f === 'expired';
  return f === status;
}
function statusOn(id: StatusFilter, status: StatusFilter = S.status) {
  return status === id || (status === 'attention' && (id === 'soon' || id === 'expired'));
}
function statusCounts(f: FilterSet) {
  const list = itemsMatching({ ...f, status: 'all' });
  const n = (fresh: Fresh) => list.filter(i => freshness(i) === fresh).length;
  return { all: list.length, soon: n('soon'), expired: n('expired'), fresh: n('fresh'), none: n('none') };
}
function activeFilterChips() {
  const chips: { key: 'status' | 'cat' | 'loc'; label: string; cls: string }[] = [];
  if (S.status !== 'all') chips.push({ key: 'status', label: STATUS_LABEL[S.status], cls: S.status === 'attention' ? 'soon' : S.status });
  if (S.cat !== 'all') { const c = catOf(S.cat); chips.push({ key: 'cat', label: `${c.icon} ${c.name}`, cls: '' }); }
  if (S.loc !== 'all') chips.push({ key: 'loc', label: S.loc, cls: '' });
  if (!chips.length) return '';
  return `<div class="chips active-filters">${chips.map(c =>
    `<button class="chip rem ${c.cls}" data-clear="${c.key}">${esc(c.label)} <span class="x" aria-hidden="true">✕</span></button>`).join('')}</div>`;
}
function filtered() {
  const list = itemsMatching();
  const by = { expiry: (a: Item, b: Item) => (a.expiry ?? '9999').localeCompare(b.expiry ?? '9999'), name: (a: Item, b: Item) => a.name.localeCompare(b.name), added: (a: Item, b: Item) => b.addedAt - a.addedAt };
  return list.sort(by[S.sort]);
}
function bindItems() {
  const q = $<HTMLInputElement>('#q');
  // Only re-render the results while typing so the iOS keyboard stays open.
  q?.addEventListener('input', () => { S.q = q.value; $('#results').innerHTML = resultsHtml(); bindResults(); });
  document.querySelectorAll<HTMLElement>('[data-view]').forEach(b => b.onclick = () => { S.view = b.dataset.view as any; S.cat = 'all'; render(); });
  $('#soon')?.addEventListener('click', () => showStatus('attention'));
  $('#filter-btn')?.addEventListener('click', openFilterSheet);
  $<HTMLSelectElement>('#sort')?.addEventListener('change', e => { S.sort = (e.target as HTMLSelectElement).value as any; render(); });
  document.querySelectorAll<HTMLElement>('[data-clear]').forEach(b => b.onclick = () => {
    const k = b.dataset.clear;
    if (k === 'status') S.status = 'all';
    else if (k === 'cat') S.cat = 'all';
    else S.loc = 'all';
    render();
  });
  bindResults();
}
function showStatus(status: StatusFilter) {
  S.tab = 'items'; S.view = 'list'; S.cat = 'all'; S.loc = 'all'; S.q = ''; S.sort = 'expiry'; S.status = status;
  render(); window.scrollTo(0, 0);
}
function openFilterSheet() {
  const draft: FilterSet = currentFilters();
  const s = sheet(`<div id="filter-body">${filterSheetHtml(draft)}</div>`);
  const paint = () => { $('#filter-body', s.el).innerHTML = filterSheetHtml(draft); bind(); };
  const bind = () => {
    s.el.querySelectorAll<HTMLElement>('[data-status]').forEach(b => b.onclick = () => { draft.status = b.dataset.status as StatusFilter; paint(); });
    s.el.querySelectorAll<HTMLElement>('[data-cat]').forEach(b => b.onclick = () => { draft.cat = b.dataset.cat!; paint(); });
    s.el.querySelectorAll<HTMLElement>('[data-loc]').forEach(b => b.onclick = () => { draft.loc = b.dataset.loc as FilterSet['loc']; paint(); });
    $('#f-clear', s.el).onclick = () => { draft.status = 'all'; draft.cat = 'all'; draft.loc = 'all'; paint(); };
    $('#f-apply', s.el).onclick = () => {
      S.status = draft.status; S.cat = draft.cat; S.loc = draft.loc;
      if (S.cat !== 'all' || S.status !== 'all' || S.loc !== 'all') S.view = 'list';
      s.close(); render();
    };
  };
  bind();
}
function filterSheetHtml(f: FilterSet) {
  const sc = statusCounts(f);
  const n = itemsMatching(f).length;
  const usedCats = S.cats.filter(c => active().some(i => i.categoryId === c.id));
  const catCount = (id: string) => itemsMatching({ ...f, cat: id }).length;
  const locCount = (loc: FilterSet['loc']) => itemsMatching({ ...f, loc }).length;
  const chip = (on: boolean, extra: string, attrs: string, label: string, count: number) =>
    `<button class="chip ${extra} ${on ? 'on' : ''}" ${attrs}>${label} <span class="n">${count}</span></button>`;
  return `
    <h2>Filter</h2>
    <h3 class="filter-h">Status</h3>
    <div class="chips wrap">${STATUS_CHIPS.map(([id, label, cls]) =>
      chip(statusOn(id, f.status), cls, `data-status="${id}"`, label, id === 'all' ? sc.all : sc[id as Fresh])).join('')}</div>
    <h3 class="filter-h">Category</h3>
    <div class="chips wrap">${chip(f.cat === 'all', '', 'data-cat="all"', 'All', itemsMatching({ ...f, cat: 'all' }).length)}
      ${usedCats.map(c => chip(f.cat === c.id, '', `data-cat="${c.id}"`, `${c.icon} ${esc(c.name)}`, catCount(c.id))).join('')}</div>
    <h3 class="filter-h">Location</h3>
    <div class="chips wrap">${(['all', 'Fridge', 'Freezer', 'Pantry'] as const).map(l =>
      chip(f.loc === l, '', `data-loc="${l}"`, l === 'all' ? 'All' : l, locCount(l))).join('')}</div>
    <div class="sheet-foot">
      <button class="btn ghost" id="f-clear" ${activeFilterCount(f) ? '' : 'disabled'}>Clear all</button>
      <button class="btn primary" id="f-apply">Show ${n} item${n === 1 ? '' : 's'}</button>
    </div>`;
}
function bindResults() {
  document.querySelectorAll<HTMLElement>('[data-cat]').forEach(b => b.onclick = () => { S.cat = b.dataset.cat!; S.view = 'list'; render(); });
  document.querySelectorAll<HTMLElement>('.item').forEach(li => li.onclick = () => editItem(S.items.find(i => i.id === li.dataset.id)!));
}

// ---------- add flows ----------
function addMenu() {
  const s = sheet(`<h2>Add items</h2>
    <button class="action" data-a="barcode"><span>📷</span><span><b>Scan barcode</b><small>Looks up the product for you</small></span></button>
    <button class="action" data-a="receipt"><span>🧾</span><span><b>Scan receipt</b><small>Adds a whole shop at once</small></span></button>
    <button class="action" data-a="manual"><span>✏️</span><span><b>Add manually</b><small>Type it in</small></span></button>`);
  s.el.querySelectorAll<HTMLElement>('[data-a]').forEach(b => b.onclick = () => {
    s.close();
    ({ barcode: barcodeFlow, receipt: receiptFlow, manual: () => editItem(null) } as any)[b.dataset.a!]();
  });
}

async function barcodeFlow() {
  const code = await (await scanner()).scanBarcode();
  if (!code) return;
  if (code === 'manual') return editItem(null);
  const done = busy('Looking up product…');
  const p = await lookupBarcode(code);
  done();
  // Same barcode already in stock? Offer a quick +1 instead of a duplicate.
  const existing = active().find(i => i.barcode === code);
  if (existing && confirm(`You already have ${existing.name} (×${existing.quantity}). Add 1 to its quantity?\n\nCancel adds it as a separate item (e.g. a different expiry).`)) {
    await saveItem({ ...existing, quantity: existing.quantity + 1 }); render(); return toast(`${existing.name}: ×${existing.quantity + 1}`);
  }
  if (!p) toast('Product not found. Enter the details.');
  const name = p ? [p.name, p.quantity].filter(Boolean).join(' ') : '';
  const catId = name ? guessCategory(`${name} ${p?.categoriesText ?? ''}`) : 'other';
  editItem(null, { name, brand: p?.brand, image: p?.image, barcode: code, categoryId: catId, location: defaultLocation(catId) }, !!name);
}

async function receiptFlow() {
  if (!hasKey(S.settings)) { toast('Add your AI key in Settings to scan receipts'); S.tab = 'settings'; render(); return; }
  const blob = await (await scanner()).capturePhoto('Scan receipt', 'Fit the whole receipt in view, flat and well lit');
  if (!blob) return;
  const done = busy('Reading receipt…');
  let lines;
  try { lines = await extractReceipt(S.settings, await fileToJpeg(blob, 2000), S.cats); }
  catch (e: any) { done(); return alert(e.message); }
  done();
  if (!lines.length) return toast('No items found on that receipt');
  const catOpts = (sel: string) => S.cats.map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${c.icon} ${esc(c.name)}</option>`).join('');
  const s = sheet(`<h2>Review receipt</h2><p class="muted">Untick anything you don't want. Tap a name to edit it.</p>
    <ul class="review">${lines.map((l, n) => `<li data-n="${n}">
      <input type="checkbox" checked aria-label="Include">
      <div class="rv-main"><input class="rv-name" value="${esc(l.name)}"><div class="rv-sub">
        <select class="rv-cat">${catOpts(l.categoryId)}</select>
        <input class="rv-qty" type="number" min="1" inputmode="numeric" value="${l.quantity}" aria-label="Quantity"></div></div></li>`).join('')}</ul>
    <div class="sheet-foot"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="rv-add">Add items</button></div>`, { full: true });
  $('#rv-add', s.el).onclick = async () => {
    let n = 0;
    for (const li of s.el.querySelectorAll<HTMLElement>('.review li')) {
      if (!$<HTMLInputElement>('input[type=checkbox]', li).checked) continue;
      const name = $<HTMLInputElement>('.rv-name', li).value.trim(); if (!name) continue;
      const categoryId = $<HTMLSelectElement>('.rv-cat', li).value;
      await saveItem({ ...blank(), name, categoryId, location: defaultLocation(categoryId), quantity: Math.max(1, +$<HTMLInputElement>('.rv-qty', li).value || 1) });
      n++;
    }
    s.close(); S.tab = 'items'; render(); toast(`Added ${n} item${n === 1 ? '' : 's'}. Tap one to add its expiry.`);
  };
}

const blank = (): Item => ({ id: db.uid(), name: '', categoryId: 'other', location: 'Pantry', quantity: 1, addedAt: Date.now(), status: 'active' });
async function saveItem(i: Item) {
  await db.put('items', i);
  const k = S.items.findIndex(x => x.id === i.id);
  if (k >= 0) S.items[k] = i; else S.items.push(i);
  // Bought it again: tick it off the shopping list
  const match = S.shop.find(s => !s.done && s.name.toLowerCase() === i.name.toLowerCase());
  if (match && k < 0) { match.done = true; await db.put('shopping', match); }
}

// ---------- item editor ----------
function editItem(existing: Item | null, prefill: Partial<Item> = {}, autoCat = false) {
  const it: Item = existing ? { ...existing } : { ...blank(), ...prefill };
  let catTouched = !!existing || (!!prefill.categoryId && !autoCat);
  const s = sheet(`
    <div class="ed-head">${it.image ? `<img class="ed-img" src="${esc(it.image)}" alt="">` : ''}<h2>${existing ? 'Edit item' : 'New item'}</h2></div>
    ${existing ? `<div class="finish"><button class="btn used" id="e-used">✅ Used it</button><button class="btn binned" id="e-binned">🗑️ Binned it</button></div>` : ''}
    <label class="field"><span>Name</span><input id="e-name" value="${esc(it.name)}" placeholder="e.g. Greek yoghurt" autocomplete="off"></label>
    <label class="field"><span>Expiry date</span>
      <div class="date-row"><input id="e-exp" type="date" value="${it.expiry ?? ''}"><button class="btn tonal" id="e-scan">📷 Scan</button></div>
      <small class="muted" id="e-exp-note">${it.expiryMonthOnly ? 'Month-only date: set to end of month' : ''}</small></label>
    <div class="field"><span>Category <small class="muted" id="e-cat-ai"></small></span><div class="cat-pick" id="e-cats">${S.cats.map(c => `<button class="chip ${c.id === it.categoryId ? 'on' : ''}" data-c="${c.id}">${c.icon} ${esc(c.name)}</button>`).join('')}</div></div>
    <div class="field"><span>Stored in</span><div class="seg" id="e-loc">${(['Fridge', 'Freezer', 'Pantry'] as Location[]).map(l => `<button data-l="${l}" class="${it.location === l ? 'on' : ''}">${{ Fridge: '❄️', Freezer: '🧊', Pantry: '🗄️' }[l]} ${l}</button>`).join('')}</div></div>
    <div class="two">
      <div class="field"><span>Quantity</span><div class="stepper"><button data-q="-1">−</button><input id="e-qty" type="number" min="1" inputmode="numeric" value="${it.quantity}"><button data-q="1">＋</button></div></div>
      <label class="field"><span>Opened on</span><input id="e-open" type="date" value="${it.opened ?? ''}"></label>
    </div>
    <details class="more"><summary>More</summary><label class="field"><span>Brand</span><input id="e-brand" value="${esc(it.brand ?? '')}"></label>${it.barcode ? `<p class="muted">Barcode ${esc(it.barcode)}</p>` : ''}</details>
    <div class="sheet-foot">${existing ? '<button class="btn ghost danger" id="e-del">Delete</button>' : '<button class="btn ghost" data-close>Cancel</button>'}<button class="btn primary" id="e-save">Save</button></div>`, { full: true });
  const el = s.el;
  const setCat = (id: string) => { it.categoryId = id; el.querySelectorAll<HTMLElement>('[data-c]').forEach(b => b.classList.toggle('on', b.dataset.c === id)); };
  el.querySelectorAll<HTMLElement>('[data-c]').forEach(b => b.onclick = () => { catTouched = true; setCat(b.dataset.c!); $('#e-cat-ai', el).textContent = ''; });
  el.querySelectorAll<HTMLElement>('[data-l]').forEach(b => b.onclick = () => { it.location = b.dataset.l as Location; el.querySelectorAll<HTMLElement>('[data-l]').forEach(x => x.classList.toggle('on', x === b)); });
  const qty = $<HTMLInputElement>('#e-qty', el);
  el.querySelectorAll<HTMLElement>('[data-q]').forEach(b => b.onclick = () => { qty.value = String(Math.max(1, (+qty.value || 1) + +b.dataset.q!)); });

  // Category auto-suggest: instant keyword guess, then AI if a key is set.
  const autoCategorise = async () => {
    const name = $<HTMLInputElement>('#e-name', el).value.trim();
    if (!name || catTouched) return;
    const g = guessCategory(name); setCat(g);
    if (!hasKey(S.settings)) return;
    $('#e-cat-ai', el).textContent = '· AI thinking…';
    try {
      const id = await suggestCategory(S.settings, name, S.cats);
      if (id && !catTouched) { setCat(id); $('#e-cat-ai', el).textContent = '· suggested by AI'; if (!existing) { it.location = defaultLocation(id); el.querySelectorAll<HTMLElement>('[data-l]').forEach(x => x.classList.toggle('on', x.dataset.l === it.location)); } }
      else $('#e-cat-ai', el).textContent = '';
    } catch { $('#e-cat-ai', el).textContent = ''; }
  };
  $('#e-name', el).addEventListener('change', autoCategorise);
  if (autoCat) autoCategorise();
  $('#e-exp', el).addEventListener('change', () => { it.expiryMonthOnly = false; $('#e-exp-note', el).textContent = ''; });

  $('#e-scan', el).onclick = async () => {
    const r = await scanExpiry();
    if (!r) return;
    $<HTMLInputElement>('#e-exp', el).value = r.iso; it.expiryMonthOnly = r.monthOnly;
    $('#e-exp-note', el).textContent = r.monthOnly ? 'Month-only date: set to end of month' : '';
  };
  $('#e-save', el).onclick = async () => {
    it.name = $<HTMLInputElement>('#e-name', el).value.trim();
    if (!it.name) { $<HTMLInputElement>('#e-name', el).focus(); return toast('Give it a name'); }
    it.expiry = $<HTMLInputElement>('#e-exp', el).value || undefined;
    it.opened = $<HTMLInputElement>('#e-open', el).value || undefined;
    it.quantity = Math.max(1, +qty.value || 1);
    it.brand = $<HTMLInputElement>('#e-brand', el).value.trim() || undefined;
    await saveItem(it); s.close(); if (!existing) S.tab = 'items'; render(); toast(existing ? 'Saved' : 'Added');
  };
  $('#e-del', el)?.addEventListener('click', async () => {
    if (!confirm(`Delete ${it.name}?`)) return;
    await db.del('items', it.id); S.items = S.items.filter(x => x.id !== it.id); s.close(); render();
  });
  const finish = async (type: 'used' | 'binned') => {
    const ev: WasteEvent = { id: db.uid(), name: existing!.name, categoryId: existing!.categoryId, type, at: Date.now() };
    await db.put('events', ev); S.events.push(ev);
    const cur = { ...existing! };
    if (cur.quantity > 1) { cur.quantity--; await saveItem(cur); toast(`${type === 'used' ? 'Used' : 'Binned'} one. ${cur.quantity} left.`); }
    else {
      cur.status = type; cur.finishedAt = Date.now(); await saveItem(cur);
      if (!S.shop.some(x => !x.done && x.name.toLowerCase() === cur.name.toLowerCase())) {
        const si: ShopItem = { id: db.uid(), name: cur.name, done: false, addedAt: Date.now(), fromItemId: cur.id };
        await db.put('shopping', si); S.shop.push(si);
      }
      toast(`${cur.name} added to your shopping list`);
    }
    s.close(); render();
  };
  $('#e-used', el)?.addEventListener('click', () => finish('used'));
  $('#e-binned', el)?.addEventListener('click', () => finish('binned'));
  if (!existing && !it.name) setTimeout(() => $<HTMLInputElement>('#e-name', el).focus(), 300);
}

/** Capture → read with AI (or Tesseract offline) → confirm/edit. Returns null if cancelled. */
async function scanExpiry(): Promise<{ iso: string; monthOnly: boolean } | null> {
  const blob = await (await scanner()).capturePhoto('Scan expiry date', 'Fill the box with the date, e.g. “BB 12/03/26”');
  if (!blob) return null;
  const done = busy('Reading date…');
  let iso: string | null = null, monthOnly = false, raw = '', err = '';
  try {
    if (hasKey(S.settings)) {
      const r = await readExpiry(S.settings, await fileToJpeg(blob, 1280));
      raw = r.raw;
      // Prefer our deterministic DD/MM parser on the text the AI saw; fall back to the AI's own date.
      const p = parseExpiry(r.raw);
      if (p) { iso = p.iso; monthOnly = p.monthOnly; } else if (r.date) { iso = r.date; monthOnly = r.monthOnly; }
    } else {
      raw = (await (await scanner()).ocrText(blob)).replace(/\s+/g, ' ').trim();
      const p = parseExpiry(raw); if (p) { iso = p.iso; monthOnly = p.monthOnly; raw = p.raw; }
    }
  } catch (e: any) { err = e.message; }
  done();
  return new Promise(resolve => {
    const s = sheet(`<h2>${iso ? 'Is this right?' : "Couldn't read a date"}</h2>
      ${iso ? `<p class="big-date">${monthOnly ? localDate(iso).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }) : formatDate(iso)}</p>` : ''}
      ${raw ? `<p class="muted">Read: “${esc(raw.slice(0, 80))}”</p>` : ''}${err ? `<p class="muted">${esc(err)}</p>` : ''}
      ${monthOnly ? '<p class="muted">Month-only date. It will be set to the last day of the month.</p>' : ''}
      <label class="field"><span>${iso ? 'Adjust if needed' : 'Enter it manually'}</span><input id="x-date" type="date" value="${iso ?? ''}"></label>
      <div class="sheet-foot"><button class="btn ghost" id="x-retry">Retake</button><button class="btn primary" id="x-ok">Use date</button></div>`);
    let settled = false;
    const out = (v: { iso: string; monthOnly: boolean } | null) => { if (!settled) { settled = true; s.close(); resolve(v); } };
    $('#x-ok', s.el).onclick = () => { const v = $<HTMLInputElement>('#x-date', s.el).value; if (!v) return toast('Pick a date'); out({ iso: v, monthOnly: v === iso && monthOnly }); };
    $('#x-retry', s.el).onclick = async () => { settled = true; s.close(); resolve(await scanExpiry()); };
    s.el.parentElement!.addEventListener('click', e => { if (e.target === s.el.parentElement) out(null); });
  });
}

// ---------- shopping ----------
function shoppingView() {
  const open = S.shop.filter(s => !s.done).sort((a, b) => b.addedAt - a.addedAt);
  const done = S.shop.filter(s => s.done);
  return `<header class="hdr"><h1>Shopping list</h1>${done.length ? '<button class="link" id="clear-done">Clear ticked</button>' : ''}</header>
    <form class="search" id="add-shop"><span>＋</span><input id="shop-in" placeholder="Add to list" autocomplete="off" enterkeyhint="done"></form>
    ${open.length || done.length ? `<ul class="list shop">${[...open, ...done].map(s => `
      <li class="item ${s.done ? 'done' : ''}" data-sid="${s.id}"><span class="check">${s.done ? '✓' : ''}</span><div class="meta"><div class="name">${esc(s.name)}</div></div><button class="icon-btn" data-rm="${s.id}" aria-label="Remove">✕</button></li>`).join('')}</ul>`
      : `<div class="empty"><div class="empty-icon">🛒</div><h3>Nothing to buy</h3><p>Items you finish are added here automatically.</p></div>`}`;
}
function bindShopping() {
  $('#add-shop').onsubmit = async e => {
    e.preventDefault(); const v = $<HTMLInputElement>('#shop-in').value.trim(); if (!v) return;
    const si: ShopItem = { id: db.uid(), name: v, done: false, addedAt: Date.now() };
    await db.put('shopping', si); S.shop.push(si); render(); $<HTMLInputElement>('#shop-in').focus();
  };
  document.querySelectorAll<HTMLElement>('[data-sid]').forEach(li => li.onclick = async e => {
    if ((e.target as HTMLElement).closest('[data-rm]')) return;
    const si = S.shop.find(x => x.id === li.dataset.sid)!; si.done = !si.done; await db.put('shopping', si); render();
  });
  document.querySelectorAll<HTMLElement>('[data-rm]').forEach(b => b.onclick = async () => { await db.del('shopping', b.dataset.rm!); S.shop = S.shop.filter(x => x.id !== b.dataset.rm); render(); });
  $('#clear-done')?.addEventListener('click', async () => { for (const s of S.shop.filter(x => x.done)) await db.del('shopping', s.id); S.shop = S.shop.filter(x => !x.done); render(); });
}

// ---------- stats ----------
function statsView() {
  const since = Date.now() - 30 * 864e5;
  const recent = S.events.filter(e => e.at >= since);
  const used = recent.filter(e => e.type === 'used').length, binned = recent.filter(e => e.type === 'binned').length;
  const pct = used + binned ? Math.round((binned / (used + binned)) * 100) : 0;
  const top = Object.entries(S.events.filter(e => e.type === 'binned').reduce<Record<string, number>>((m, e) => (m[e.name] = (m[e.name] ?? 0) + 1, m), {})).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const a = active();
  return `<header class="hdr"><h1>Stats</h1></header>
    <div class="cards">
      <div class="card"><b>${a.length}</b><span>In stock</span></div>
      <button class="card amber" data-jump="soon" aria-label="Show items expiring soon"><b>${a.filter(i => freshness(i) === 'soon').length}</b><span>Expiring soon</span></button>
      <button class="card red" data-jump="expired" aria-label="Show expired items"><b>${a.filter(i => freshness(i) === 'expired').length}</b><span>Expired</span></button>
    </div>
    <section class="panel"><h3>Last 30 days</h3>
      <div class="bar"><i style="width:${100 - pct}%"></i></div>
      <div class="row-between"><span>✅ Used <b>${used}</b></span><span>🗑️ Binned <b>${binned}</b></span></div>
      <p class="muted">${used + binned ? `You binned ${pct}% of what you finished.` : 'Tap “Used it” or “Binned it” on an item to start tracking waste.'}</p></section>
    ${top.length ? `<section class="panel"><h3>Most often binned</h3><ul class="plain">${top.map(([n, c]) => `<li><span>${esc(n)}</span><b>${c}×</b></li>`).join('')}</ul></section>` : ''}`;
}
function bindStats() {
  document.querySelectorAll<HTMLElement>('[data-jump]').forEach(b => b.onclick = () => showStatus(b.dataset.jump as StatusFilter));
}

// ---------- settings ----------
function settingsView() {
  const st = S.settings; const g = st.provider === 'gemini';
  const notif = 'Notification' in window ? Notification.permission : 'unsupported';
  return `<header class="hdr"><h1>Settings</h1></header>
    <section class="panel"><h3>AI for receipts, dates and categories</h3>
      <div class="seg" id="prov"><button data-p="gemini" class="${g ? 'on' : ''}">Google Gemini (free)</button><button data-p="openai" class="${!g ? 'on' : ''}">OpenAI</button></div>
      ${g ? `<label class="field"><span>Gemini API key</span><input id="s-key" type="password" autocomplete="off" placeholder="AIza…" value="${esc(st.geminiKey)}"></label>
        <p class="muted">Get a free key at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">aistudio.google.com/app/apikey</a>. On the free tier Google may use what you send to improve its products.</p>
        <label class="field"><span>Model</span><select id="s-model">${['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite'].map(m => `<option ${m === st.geminiModel ? 'selected' : ''}>${m}</option>`).join('')}</select></label>`
      : `<label class="field"><span>OpenAI API key</span><input id="s-key" type="password" autocomplete="off" placeholder="sk-…" value="${esc(st.openaiKey)}"></label>
        <p class="muted">Create one at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com/api-keys</a>. Paid per use, usually a few cents a month.</p>
        <label class="field"><span>Model</span><input id="s-model" value="${esc(st.openaiModel)}"></label>`}
      <p class="note">🔒 Your key is saved only on this phone. It is sent only to ${g ? 'Google' : 'OpenAI'} when you scan, and is never included in backups.</p>
      <button class="btn tonal" id="s-test">Test key</button>
    </section>
    <section class="panel"><h3>Reminders</h3>
      <label class="field"><span>Warn me this many days before expiry</span><div class="stepper"><button data-d="-1">−</button><input id="s-days" type="number" min="0" max="30" value="${st.leadDays}"><button data-d="1">＋</button></div></label>
      <p class="muted">Notifications: <b>${({ granted: 'On', denied: 'Blocked (turn on in iPhone Settings › Notifications › Pantry)', default: 'Off', unsupported: 'Not available here. Open the app from your Home Screen.' } as Record<string, string>)[notif]}</b>. They appear when you open the app. On iPhone this needs iOS 16.4+ and the app added to your Home Screen.</p>
      ${notif === 'default' ? '<button class="btn tonal" id="s-notif">Turn on notifications</button>' : ''}
    </section>
    <section class="panel"><h3>Categories</h3>
      <ul class="plain cats">${S.cats.map(c => `<li><span>${c.icon} ${esc(c.name)}</span>${c.preset ? '' : `<button class="icon-btn" data-delcat="${c.id}" aria-label="Delete">✕</button>`}</li>`).join('')}</ul>
      <button class="btn tonal" id="s-addcat">＋ New category</button>
    </section>
    <section class="panel"><h3>Backup</h3>
      <div class="two"><button class="btn tonal" id="s-export">Export</button><label class="btn tonal">Import<input type="file" id="s-import" accept="application/json,.json" hidden></label></div>
      <p class="muted">Data lives only on this phone. Export now and then so you don't lose it if you change phones.</p>
    </section>
    <p class="muted center">Pantry · everything stays on your device</p>`;
}
function bindSettings() {
  const st = S.settings;
  const save = async () => { await db.saveSettings(st); };
  document.querySelectorAll<HTMLElement>('[data-p]').forEach(b => b.onclick = async () => { st.provider = b.dataset.p as any; await save(); render(); });
  $<HTMLInputElement>('#s-key').addEventListener('change', async e => { const v = (e.target as HTMLInputElement).value.trim(); if (st.provider === 'gemini') st.geminiKey = v; else st.openaiKey = v; await save(); toast('Key saved on this phone'); });
  $<HTMLInputElement>('#s-model').addEventListener('change', async e => { const v = (e.target as HTMLInputElement).value.trim(); if (st.provider === 'gemini') st.geminiModel = v; else st.openaiModel = v || 'gpt-4o-mini'; await save(); });
  $('#s-test').onclick = async () => {
    const k = $<HTMLInputElement>('#s-key').value.trim(); if (st.provider === 'gemini') st.geminiKey = k; else st.openaiKey = k; await save();
    const done = busy('Testing…');
    try { await askAI(st, 'Reply with JSON {"ok": true}'); done(); toast('✅ Key works'); } catch (e: any) { done(); alert(e.message); }
  };
  const days = $<HTMLInputElement>('#s-days');
  const setDays = async (n: number) => { st.leadDays = Math.min(30, Math.max(0, n)); days.value = String(st.leadDays); await save(); };
  days.addEventListener('change', () => setDays(+days.value || 0));
  document.querySelectorAll<HTMLElement>('[data-d]').forEach(b => b.onclick = () => setDays(st.leadDays + +b.dataset.d!));
  $('#s-notif')?.addEventListener('click', async () => { await Notification.requestPermission(); render(); checkReminders(true); });
  document.querySelectorAll<HTMLElement>('[data-delcat]').forEach(b => b.onclick = async () => {
    const id = b.dataset.delcat!; const n = S.items.filter(i => i.categoryId === id && i.status === 'active').length;
    if (!confirm(`Delete this category?${n ? ` ${n} item(s) will move to Other.` : ''}`)) return;
    for (const i of S.items.filter(i => i.categoryId === id)) { i.categoryId = 'other'; await db.put('items', i); }
    await db.del('categories', id); S.cats = S.cats.filter(c => c.id !== id); render();
  });
  $('#s-addcat').onclick = () => {
    let icon = ICON_CHOICES[0];
    const s = sheet(`<h2>New category</h2><label class="field"><span>Name</span><input id="c-name" placeholder="e.g. Baby food"></label>
      <div class="field"><span>Icon</span><div class="icons">${ICON_CHOICES.map((i, n) => `<button class="${n ? '' : 'on'}" data-i="${i}">${i}</button>`).join('')}</div>
      <input id="c-custom" placeholder="…or type any emoji" maxlength="4"></div>
      <div class="sheet-foot"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="c-save">Add</button></div>`);
    s.el.querySelectorAll<HTMLElement>('[data-i]').forEach(b => b.onclick = () => { icon = b.dataset.i!; s.el.querySelectorAll('[data-i]').forEach(x => x.classList.toggle('on', x === b)); });
    $('#c-save', s.el).onclick = async () => {
      const name = $<HTMLInputElement>('#c-name', s.el).value.trim(); if (!name) return toast('Give it a name');
      const c: Category = { id: 'c-' + db.uid().slice(0, 8), name, icon: $<HTMLInputElement>('#c-custom', s.el).value.trim() || icon };
      await db.put('categories', c); S.cats.push(c); s.close(); render();
    };
  };
  $('#s-export').onclick = async () => {
    const data = JSON.stringify(await db.exportData(), null, 2);
    const file = new File([data], `pantry-backup-${todayISO()}.json`, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: 'Pantry backup' }); return; } catch { /* cancelled */ return; } }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
  };
  $<HTMLInputElement>('#s-import').addEventListener('change', async e => {
    const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
    if (!confirm('Replace everything in the app with this backup?')) return;
    try { await db.importData(JSON.parse(await f.text())); await load(); render(); toast('Backup restored'); } catch (err: any) { alert(err.message); }
  });
}

// ---------- reminders ----------
async function checkReminders(force = false) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const today = todayISO();
  if (!force && S.settings.lastNotified === today) return;  // at most once a day
  const soon = expiringSoon(); if (!soon.length) return;
  const body = soon.slice(0, 5).map(i => `${i.name}: ${expiryLabel(i).toLowerCase()}`).join('\n') + (soon.length > 5 ? `\n+${soon.length - 5} more` : '');
  const title = `${soon.length} item${soon.length > 1 ? 's' : ''} expiring soon`;
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg) await reg.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'expiry' });
    else new Notification(title, { body });
    S.settings.lastNotified = today; await db.saveSettings(S.settings);
  } catch { /* ignore */ }
}

// ---------- boot ----------
(async () => {
  await load();
  if (new URLSearchParams(location.search).has('demo') && !S.items.length) await seedDemo();
  render();
  checkReminders();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { render(); checkReminders(); } });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  setTimeout(() => scanner().catch(() => {}), 3000); // warm the cache so scanning works offline
})();

/** ?demo in the URL fills an empty app with sample items (used for screenshots). */
async function seedDemo() {
  const d = (n: number) => { const x = new Date(); x.setDate(x.getDate() + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  const rows: [string, string, Location, number, number | null][] = [
    ['Full Cream Milk 2L', 'dairy', 'Fridge', 1, 2], ['Greek Yoghurt', 'dairy', 'Fridge', 1, -1], ['Baby Spinach', 'produce', 'Fridge', 1, 1],
    ['Chicken Thighs 500g', 'meat', 'Fridge', 1, 4], ['Sourdough Loaf', 'bakery', 'Pantry', 1, 6], ['Frozen Peas 1kg', 'frozen', 'Freezer', 1, 120],
    ['Spaghetti 500g', 'pantry', 'Pantry', 2, 300], ['Diced Tomatoes 400g', 'canned', 'Pantry', 3, 420], ['Tim Tams', 'snacks', 'Pantry', 1, 45],
  ];
  for (const [name, categoryId, location, quantity, days] of rows) await saveItem({ ...blank(), name, categoryId, location, quantity, expiry: days === null ? undefined : d(days) });
  const si: ShopItem = { id: db.uid(), name: 'Eggs', done: false, addedAt: Date.now() }; await db.put('shopping', si); S.shop.push(si);
}
