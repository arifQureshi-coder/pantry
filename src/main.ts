import './style.css';
import type { Item, Category, Collection, ShopItem, Settings, Location, WasteEvent, Purchase } from './types';
import * as db from './db';
import { guessCategory, defaultLocation, ICON_CHOICES } from './categories';
import { daysUntil, formatDate, parseExpiry } from './dates';
import { lookupBarcode } from './off';
import { askAI, extractReceipt, readExpiry, suggestCategory, suggestCategories, fileToJpeg, hasKey } from './ai';
import { ocrExpiry, ocrReceiptPhotos } from './ocr';
import { joinReceiptTexts, parseReceiptText, receiptTotalCheck, shouldFallbackToAi } from './receipt';
// Camera/barcode code (~400 KB) is loaded only when first needed.
const scanner = () => import('./scanner');

// ---------- state ----------
type Tab = 'items' | 'shopping' | 'stats' | 'settings';
type StatusFilter = 'all' | 'soon' | 'expired' | 'fresh' | 'none' | 'attention' | 'noexpiry';
/** Two home views: Grid (default) and List (grouped by category, headers folded until tapped). */
type ItemsView = 'grid' | 'list';
const expandedCats = new Set<string>();
function isItemsView(v: unknown): v is ItemsView { return v === 'list' || v === 'grid'; }
async function applyView(v: ItemsView) {
  S.view = v; S.cat = 'all'; expandedCats.clear();
  S.settings.homeView = v; await db.saveSettings(S.settings);
  render();
}

const S = {
  tab: 'items' as Tab,
  items: [] as Item[], cats: [] as Category[], cols: [] as Collection[], col: 'all' as string, shop: [] as ShopItem[], events: [] as WasteEvent[], purchases: [] as Purchase[],
  settings: db.DEFAULT_SETTINGS as Settings,
  shopCol: 'all' as string, q: '', cat: 'all', loc: 'all' as 'all' | Location, sort: 'expiry' as 'expiry' | 'name' | 'added', view: 'grid' as ItemsView,
  status: 'all' as StatusFilter,
};
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const localDate = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
/** Shown when an item's category was deleted (or "Other" itself was deleted). */
const FALLBACK_CAT: Category = { id: 'other', name: 'Uncategorised', icon: '📦' };
const catOf = (id: string) => S.cats.find(c => c.id === id) ?? S.cats.find(c => c.id === 'other') ?? FALLBACK_CAT;
/** The category an item is shown under: its own, or the Other/Uncategorised fallback. */
const catKey = (id: string) => S.cats.some(c => c.id === id) ? id : 'other';
/** Categories to group by: the user's list, plus the fallback if items need it and Other was deleted. */
const displayCats = () => S.cats.some(c => c.id === 'other') ? S.cats : [...S.cats, FALLBACK_CAT];
const colId = (i: { collectionId?: string }) => S.cols.some(c => c.id === i.collectionId) ? i.collectionId! : db.REGULAR_ID;
const colOf = (id?: string) => S.cols.find(c => c.id === id) ?? S.cols.find(c => c.id === db.REGULAR_ID) ?? db.REGULAR;
const sortedCols = () => [...S.cols].sort((a, b) => (a.id === db.REGULAR_ID ? -1 : b.id === db.REGULAR_ID ? 1 : a.createdAt - b.createdAt));
const active = () => S.items.filter(i => i.status === 'active');
const money = (n: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n);
const parseQty = (v: string) => Math.max(1, Math.round(+v || 1));
const parseMoney = (v: string) => {
  const t = v.replace(/[$,\s]/g, '');
  const n = t ? Number(t) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined;
};
function lastPaid(opts: { barcode?: string; name?: string }): number | undefined {
  const code = opts.barcode, name = opts.name?.trim().toLowerCase();
  const buys = S.purchases.filter(p => p.unitPrice > 0).sort((a, b) => b.at - a.at);
  if (code) { const hit = buys.find(p => p.barcode === code); if (hit) return hit.unitPrice; }
  if (name) { const hit = buys.find(p => p.name.toLowerCase() === name); if (hit) return hit.unitPrice; }
  const items = [...S.items].filter(i => i.price && i.price > 0).sort((a, b) => b.addedAt - a.addedAt);
  if (code) { const hit = items.find(i => i.barcode === code); if (hit) return hit.price; }
  if (name) { const hit = items.find(i => i.name.toLowerCase() === name); if (hit) return hit.price; }
}
async function recordPurchase(i: Item, quantity: number, unitPrice: number, at = Date.now(), total?: number) {
  if (!(unitPrice > 0) || quantity <= 0) return;
  const p: Purchase = { id: db.uid(), itemId: i.id, name: i.name, barcode: i.barcode, categoryId: i.categoryId, collectionId: colId(i), boughtAt: db.boughtTime(i), unitPrice, quantity, total: total ?? Math.round(unitPrice * quantity * 100) / 100, at };
  await db.put('purchases', p); S.purchases.push(p);
}

async function load() {
  S.cats = await db.ensureCategories();
  S.cols = await db.ensureCollections();
  if (S.col !== 'all' && !S.cols.some(c => c.id === S.col)) S.col = 'all';
  [S.items, S.shop, S.events, S.settings, S.purchases] = await Promise.all([db.getAll<Item>('items'), db.getAll<ShopItem>('shopping'), db.getAll<WasteEvent>('events'), db.getSettings(), db.getAll<Purchase>('purchases')]);
  S.view = isItemsView(S.settings.homeView) ? S.settings.homeView : 'grid';
  for (const i of S.items) if (!i.collectionId) i.collectionId = db.REGULAR_ID;
}

// ---------- expiry helpers ----------
type Fresh = 'fresh' | 'soon' | 'expired' | 'none';
function freshness(i: Item): Fresh {
  if (i.noExpiry || !i.expiry || i.expiryStatus === 'reading' || i.expiryStatus === 'failed') return 'none';
  const d = daysUntil(i.expiry);
  return d < 0 ? 'expired' : d <= S.settings.leadDays ? 'soon' : 'fresh';
}
function dateLabel(i: Item) {
  if (i.noExpiry) return '— No expiry';
  if (!i.expiry) return 'No date';
  const d = daysUntil(i.expiry);
  if (d < 0) return d === -1 ? 'Expired yesterday' : `Expired ${-d}d ago`;
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d <= 30) return `${d} days`;
  return i.expiryMonthOnly ? localDate(i.expiry).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' }) : formatDate(i.expiry);
}
function expiryLabel(i: Item) {
  if (i.noExpiry) return '— No expiry';
  if (i.expiryStatus === 'reading') return 'Reading…';
  if (i.expiryStatus === 'failed') return "Couldn't read, tap to enter";
  if (i.expiryStatus === 'pending' && i.expiry) return dateLabel(i) + '?';
  return dateLabel(i);
}
const isFinalDate = (i: Item) => !i.noExpiry && !!i.expiry && !i.expiryStatus;
const datesToCheck = () => active().filter(i => !i.noExpiry && (i.expiryStatus === 'pending' || i.expiryStatus === 'failed')).sort((a, b) => (a.expiry ?? '9999').localeCompare(b.expiry ?? '9999'));
const expiringSoon = () => active().filter(i => isFinalDate(i) && ['soon', 'expired'].includes(freshness(i))).sort((a, b) => a.expiry!.localeCompare(b.expiry!));

// ---------- toast / sheet ----------
function toast(msg: string) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2400);
}
function sheet(html: string, opts: { full?: boolean; title?: string; lead?: string; beforeClose?: () => boolean | Promise<boolean> } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  const lead = opts.lead ? `<img class="ed-img" src="${esc(opts.lead)}" alt="">` : '';
  const title = `<h2 class="sheet-title">${esc(opts.title ?? '')}</h2>`;
  wrap.innerHTML = `<div class="sheet ${opts.full ? 'full' : ''}"><div class="grabber" aria-hidden="true"></div>
    <div class="sheet-bar"><button type="button" class="sheet-back" aria-label="Back">←</button>${lead}${title}</div>${html}</div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  const el = wrap.querySelector('.sheet') as HTMLElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 250);
  };
  const requestClose = async (): Promise<boolean> => {
    if (closed) return true;
    if (opts.beforeClose && (await opts.beforeClose()) === false) return false;
    close();
    return true;
  };
  wrap.addEventListener('click', e => { if (e.target === wrap) requestClose(); });
  wrap.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => requestClose()));
  $('.sheet-back', wrap).addEventListener('click', () => requestClose());
  enableSwipeClose(el, requestClose);
  return { el, close, requestClose };
}
function enableSwipeClose(sheetEl: HTMLElement, requestClose: () => Promise<boolean>) {
  const wrap = sheetEl.parentElement!;
  let startY = 0, startX = 0, dragging = false, active = false, dy = 0, fromHandle = false;
  const reset = () => {
    sheetEl.classList.remove('dragging');
    sheetEl.style.transform = '';
    wrap.style.background = '';
  };
  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 1 || !wrap.classList.contains('open')) return;
    const t = e.touches[0];
    const target = t.target as Element;
    fromHandle = !!target.closest('.grabber, .sheet-bar');
    if (!fromHandle && sheetEl.scrollTop > 0) return;
    startY = t.clientY; startX = t.clientX;
    dragging = true; active = false; dy = 0;
  };
  const onMove = (e: TouchEvent) => {
    if (!dragging) return;
    const t = e.touches[0];
    const raw = t.clientY - startY;
    const dx = t.clientX - startX;
    if (!active) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > raw) { dragging = false; return; }
      if (raw < 10) return;
      if (!fromHandle && sheetEl.scrollTop > 0) { dragging = false; return; }
      active = true;
      sheetEl.classList.add('dragging');
    }
    dy = Math.max(0, raw);
    sheetEl.style.transform = `translateY(${dy}px)`;
    wrap.style.background = `rgba(0,0,0,${0.4 * (1 - Math.min(dy / 420, 1))})`;
    if (e.cancelable) e.preventDefault();
  };
  const onEnd = async () => {
    if (!dragging) return;
    dragging = false;
    const shouldClose = active && dy > 100;
    reset();
    if (shouldClose) await requestClose();
  };
  sheetEl.addEventListener('touchstart', onStart, { passive: true });
  sheetEl.addEventListener('touchmove', onMove, { passive: false });
  sheetEl.addEventListener('touchend', onEnd);
  sheetEl.addEventListener('touchcancel', onEnd);
}
function askDiscard(): Promise<boolean> {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'confirm-wrap';
    wrap.innerHTML = `<div class="confirm-box" role="dialog" aria-modal="true" aria-labelledby="discard-title">
      <h3 id="discard-title">Discard changes?</h3>
      <div class="confirm-actions">
        <button type="button" class="btn ghost" data-a="keep">Keep editing</button>
        <button type="button" class="btn danger-fill" data-a="discard">Discard</button>
      </div>
    </div>`;
    document.body.appendChild(wrap);
    const done = (v: boolean) => { wrap.remove(); resolve(v); };
    wrap.addEventListener('click', e => { if (e.target === wrap) done(false); });
    wrap.querySelector('[data-a=keep]')!.addEventListener('click', () => done(false));
    wrap.querySelector('[data-a=discard]')!.addEventListener('click', () => done(true));
  });
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
  app.querySelectorAll<HTMLElement>('[data-tab]').forEach(b => b.onclick = () => { S.tab = b.dataset.tab as Tab; if (S.tab !== 'items') { selecting = false; selected.clear(); } render(); window.scrollTo(0, 0); });
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
        <button data-view="grid" class="${S.view === 'grid' ? 'on' : ''}" aria-label="Category grid">Grid</button>
        <button data-view="list" class="${S.view === 'list' ? 'on' : ''}" aria-label="List by category">List</button>
      </div>
    </header>
    ${(() => { const check = datesToCheck(); return check.length ? `<button class="banner check" id="dates-check">
        <span>📅</span><span><b>${check.length} date${check.length > 1 ? 's' : ''} to check</b><br><small>${esc(check.slice(0, 3).map(i => i.name).join(', '))}${check.length > 3 ? '…' : ''}</small></span><span>›</span></button>` : ''; })()}
    ${soon.length ? `<button class="banner ${soon.some(i => freshness(i) === 'expired') ? 'red' : ''}" id="soon">
        <span>⏰</span><span><b>${soon.length} item${soon.length > 1 ? 's' : ''} expiring soon</b><br><small>${esc(soon.slice(0, 3).map(i => i.name).join(', '))}${soon.length > 3 ? '…' : ''}</small></span><span>›</span></button>` : ''}
    <div class="search"><span>🔎</span><input id="q" type="search" placeholder="Search pantry and shopping list" value="${esc(S.q)}" autocomplete="off"></div>
    <div class="row-between">
      <div class="tb-left"><button class="btn-filter ${n ? 'on' : ''}" id="filter-btn" aria-label="${n ? `Filter, ${n} active` : 'Filter'}">Filter${n ? `<b class="fbadge">${n}</b>` : ''}</button>
      <button class="btn-filter ${selecting ? 'on' : ''}" id="sel-btn">${selecting ? 'Cancel' : 'Select'}</button></div>
      <div class="tb-right"><select id="sort" class="sort" aria-label="Sort">
        <option value="expiry" ${S.sort === 'expiry' ? 'selected' : ''}>⇅ Expiry</option>
        <option value="name" ${S.sort === 'name' ? 'selected' : ''}>⇅ A–Z</option>
        <option value="added" ${S.sort === 'added' ? 'selected' : ''}>⇅ Newest</option>
      </select>
      ${collectionSelect()}</div>
    </div>
    ${activeFilterChips()}
    <div id="results">${resultsHtml()}</div>
    ${selecting ? selBarHtml() : ''}`;
}
function collectionSelect() {
  return `<select id="col-filter" class="sort col-filter" aria-label="Collection">
    <option value="all" ${S.col === 'all' ? 'selected' : ''}>All collections</option>
    ${sortedCols().map(c => `<option value="${esc(c.id)}" ${S.col === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`;
}
function resultsHtml() {
  const list = filtered();
  if (S.q.trim() && !selecting) return searchResults() + (list.length ? clearButton(list.length) : '');
  if (S.view === 'grid' && S.cat === 'all' && !S.q && !selecting) return gridView();
  if (!list.length) return emptyState();
  return groupedView(list) + (selecting ? '' : clearButton(list.length));
}

// ---------- app-wide search: every pantry item (all categories and collections) plus the shopping list ----------
function searchResults() {
  const q = S.q.trim().toLowerCase();
  const items = active().filter(i => `${i.name} ${i.brand ?? ''} ${catOf(i.categoryId).name} ${colOf(colId(i)).name}`.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  const shop = S.shop.filter(s => !s.done && s.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  if (!items.length && !shop.length) return `<div class="empty"><div class="empty-icon">🔎</div><h3>No matches</h3><p>Nothing in your pantry or shopping list matches “${esc(S.q.trim())}”.</p></div>`;
  const row = (attr: string, icon: string, name: string, sub: string) =>
    `<li class="item sr" ${attr}><div class="thumb">${icon}</div><div class="meta"><div class="name">${esc(name)}</div><div class="sub">${esc(sub)}</div></div><span class="sr-go" aria-hidden="true">›</span></li>`;
  return `<h3 class="filter-h">Search results · ${items.length + shop.length}</h3><ul class="list" id="search-results">
    ${items.map(i => { const c = catOf(i.categoryId); return row(`data-jump-item="${i.id}"`, c.icon, i.name, `${c.name} · ${colOf(colId(i)).name}${i.quantity > 1 ? ` · ×${i.quantity}` : ''}`); }).join('')}
    ${shop.map(s => row(`data-jump-shop="${s.id}"`, '🛒', s.name, `Shopping list · ${colOf(colId(s)).name}`)).join('')}</ul>`;
}
function flash(sel: string) {
  const el = document.querySelector<HTMLElement>(sel); if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2200);
}
function jumpToShop(id: string) {
  const si = S.shop.find(s => s.id === id); if (!si) return;
  S.tab = 'shopping'; S.q = '';
  if (S.shopCol !== 'all' && colId(si) !== S.shopCol) S.shopCol = 'all';
  render(); flash(`[data-sid="${id}"]`);
}

// ---------- multi-select ----------
let selecting = false;
const selected = new Set<string>();
const selectedItems = () => active().filter(i => selected.has(i.id));
function selBarHtml() {
  const n = selected.size;
  return `<div class="sel-bar" id="sel-bar"><div class="sel-top"><b>${n} selected</b>
      <button type="button" class="link" id="sel-all">Select all</button><button type="button" class="link" id="sel-done">Done</button></div>
    <div class="sel-actions">
      <button type="button" class="btn tonal" id="sel-noexp" ${n ? '' : 'disabled'}>➖ No expiry</button>
      <button type="button" class="btn tonal" id="sel-cat" ${n ? '' : 'disabled'}>🏷️ Category</button>
      <button type="button" class="btn ghost danger" id="sel-del" ${n ? '' : 'disabled'}>🗑️ Delete</button></div></div>`;
}
function startSelect() { selecting = true; selected.clear(); render(); }
function endSelect() { selecting = false; selected.clear(); render(); }
function paintSelection() {
  $('#results').innerHTML = resultsHtml(); bindResults();
  $('#sel-bar')?.replaceWith(Object.assign(document.createElement('div'), { innerHTML: selBarHtml() }).firstElementChild!);
  bindSelBar();
}
function bindSelBar() {
  $('#sel-done')?.addEventListener('click', endSelect);
  $('#sel-all')?.addEventListener('click', () => { for (const i of filtered()) selected.add(i.id); paintSelection(); });
  $('#sel-noexp')?.addEventListener('click', async () => {
    const list = selectedItems(); if (!list.length) return;
    await setItemsNoExpiry(list);
    toast(`${list.length} item${list.length === 1 ? '' : 's'} marked No expiry`); endSelect();
  });
  $('#sel-cat')?.addEventListener('click', () => {
    const list = selectedItems(); if (!list.length) return;
    const cats = new Set(list.map(i => catKey(i.categoryId)));
    openCategorySheet(cats.size === 1 ? [...cats][0] : '', async id => {
      for (const it of list) await saveItem({ ...it, categoryId: id });
      toast(`Moved ${list.length} item${list.length === 1 ? '' : 's'} to ${catOf(id).name}`); endSelect();
    });
  });
  $('#sel-del')?.addEventListener('click', async () => {
    const list = selectedItems(); if (!list.length) return;
    if (!confirm(`Delete ${list.length} item${list.length === 1 ? '' : 's'}?`)) return;
    for (const it of list) { await cancelExpiryJobs(it.id); await db.del('items', it.id); }
    const ids = new Set(list.map(i => i.id));
    S.items = S.items.filter(x => !ids.has(x.id));
    toast(`Deleted ${list.length} item${list.length === 1 ? '' : 's'}`); endSelect();
  });
}
function groupedView(list: Item[]) {
  const byId = new Map<string, Item[]>();
  for (const i of list) {
    const id = catKey(i.categoryId);
    const arr = byId.get(id) ?? []; arr.push(i); byId.set(id, arr);
  }
  const groups = displayCats().map(c => ({ c, items: byId.get(c.id) ?? [] })).filter(g => g.items.length);
  // Folded by default; open while searching or when only one category is shown.
  const openAll = selecting || !!S.q.trim() || groups.length === 1;
  return groups.map(({ c, items }) => {
    const closed = !openAll && !expandedCats.has(c.id);
    const levels = items.map(freshness);
    const alert = levels.includes('expired') ? 'expired' : levels.includes('soon') ? 'soon' : '';
    return `<section class="cat-group${closed ? ' closed' : ''}">
      <button type="button" class="cat-h" data-toggle="${c.id}" aria-expanded="${!closed}">
        <span class="cat-h-icon">${c.icon}</span>
        <span class="cat-h-name">${esc(c.name)}</span>
        ${alert ? `<i class="dot ${alert}" aria-hidden="true"></i>` : ''}
        <span class="cat-h-n">${items.length}</span>
        <span class="cat-h-chevron" aria-hidden="true">▾</span>
      </button>
      ${closed ? '' : `<ul class="list">${items.map(i => itemRow(i, true)).join('')}</ul>`}
    </section>`;
  }).join('');
}
function gridView() {
  const counts = displayCats().map(c => {
    const its = itemsMatching({ cat: c.id });
    return { c, n: its.length, alert: its.some(i => ['soon', 'expired'].includes(freshness(i))) };
  }).filter(x => x.n);
  if (!counts.length) return emptyState();
  const shown = itemsMatching().length;
  return clearButton(shown, `<div class="grid">${counts.map(({ c, n, alert }) => `
    <button class="tile" data-cat="${c.id}">${alert ? '<i class="dot"></i>' : ''}<span class="tile-icon">${c.icon}</span><span class="tile-name">${esc(c.name)}</span><span class="tile-n">${n} item${n > 1 ? 's' : ''}</span></button>`).join('')}</div>`);
}
function clearButton(n: number, before = '') {
  return `${before}<div class="clear-wrap"><button type="button" class="btn ghost danger" id="clear-pantry">🗑️ Clear pantry (${n})</button></div>`;
}

function emptyState() {
  if (!active().length) return `<div class="empty"><div class="empty-icon">🧺</div><h3>Your pantry is empty</h3><p>Tap <b>＋</b> to scan a barcode or a receipt.</p></div>`;
  const copy: Record<StatusFilter, { icon: string; title: string; body: string }> = {
    all: { icon: '🔎', title: 'No matching items', body: 'Try a different search or filter.' },
    soon: { icon: '⏰', title: 'No items expiring soon', body: 'Nothing is due within your reminder window.' },
    expired: { icon: '⚠️', title: 'No expired items', body: 'Nothing in your pantry is past its date.' },
    fresh: { icon: '✨', title: 'No fresh items', body: 'Nothing currently matches this filter.' },
    none: { icon: '📅', title: 'No items without a date', body: 'Every item here has an expiry date.' },
    noexpiry: { icon: '➖', title: 'No items marked no expiry', body: 'Nothing is marked as not expiring.' },
    attention: { icon: '✅', title: 'Nothing needs attention', body: 'No items are expired or expiring soon.' },
  };
  const m = copy[S.status];
  const narrowed = S.q || S.cat !== 'all' || S.loc !== 'all' || S.col !== 'all';
  return `<div class="empty"><div class="empty-icon">${m.icon}</div><h3>${m.title}</h3><p>${narrowed && S.status !== 'all' ? 'Try clearing search, category or location.' : m.body}</p></div>`;
}
function itemRow(i: Item, hideCat = false) {
  const c = catOf(i.categoryId); const f = freshness(i);
  const pill = i.noExpiry ? 'noexpiry' : i.expiryStatus === 'reading' ? 'reading' : i.expiryStatus === 'failed' ? 'failed' : f + (i.expiryStatus === 'pending' ? ' pending' : '');
  const body = i.expiryStatus === 'reading' && !i.noExpiry
    ? `<i class="spin-sm" aria-hidden="true"></i> Reading…`
    : esc(expiryLabel(i));
  const col = S.col === 'all' && colId(i) !== db.REGULAR_ID ? colOf(colId(i)).name : '';
  const bits = [hideCat ? '' : c.name, i.location, col, i.quantity > 1 ? `×${i.quantity}` : '', i.opened ? 'opened' : ''].filter(Boolean);
  const pick = selecting ? `<span class="check sel-check">${selected.has(i.id) ? '✓' : ''}</span>` : '';
  return `<li class="item${selecting && selected.has(i.id) ? ' picked' : ''}" data-id="${i.id}">${pick}
    <div class="thumb">${i.image ? `<img src="${esc(i.image)}" alt="" loading="lazy" onerror="this.replaceWith(document.createTextNode('${c.icon}'))">` : c.icon}</div>
    <div class="meta"><div class="name">${esc(i.name)}</div><div class="sub">${esc(bits.join(' · '))}</div></div>
    <span class="pill ${pill}">${body}</span></li>`;
}
const STATUS_CHIPS: [StatusFilter, string, string][] = [
  ['all', 'All', ''],
  ['soon', 'Expiring soon', 'soon'],
  ['expired', 'Expired', 'expired'],
  ['fresh', 'Fresh', 'fresh'],
  ['none', 'No date', 'none'],
  ['noexpiry', 'No expiry', 'none'],
];
const STATUS_LABEL: Record<StatusFilter, string> = {
  all: 'All', soon: 'Expiring soon', expired: 'Expired', fresh: 'Fresh', none: 'No date', noexpiry: 'No expiry', attention: 'Needs attention',
};
type FilterSet = { status: StatusFilter; cat: string; loc: 'all' | Location; q: string; col: string };
const currentFilters = (): FilterSet => ({ status: S.status, cat: S.cat, loc: S.loc, q: S.q, col: S.col });
function activeFilterCount(f: FilterSet = currentFilters()) {
  return (f.status !== 'all' ? 1 : 0) + (f.cat !== 'all' ? 1 : 0) + (f.loc !== 'all' ? 1 : 0);
}
function itemsMatching(over: Partial<FilterSet> = {}) {
  const f = { ...currentFilters(), ...over };
  const q = f.q.trim().toLowerCase();
  return active().filter(i => (f.col === 'all' || colId(i) === f.col) && (f.cat === 'all' || catKey(i.categoryId) === f.cat) && (f.loc === 'all' || i.location === f.loc) &&
    (!q || `${i.name} ${i.brand ?? ''} ${catOf(i.categoryId).name}`.toLowerCase().includes(q)) &&
    matchesStatus(i, f.status));
}
function matchesStatus(i: Item, status: StatusFilter = S.status) {
  if (i.noExpiry) return status === 'all' || status === 'noexpiry';
  if (status === 'noexpiry') return false;
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
  const n = (fresh: Fresh) => list.filter(i => !i.noExpiry && freshness(i) === fresh).length;
  return { all: list.length, soon: n('soon'), expired: n('expired'), fresh: n('fresh'), none: n('none'), noexpiry: list.filter(i => i.noExpiry).length };
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
  document.querySelectorAll<HTMLElement>('[data-view]').forEach(b => b.onclick = () => applyView(b.dataset.view as ItemsView));
  $<HTMLSelectElement>('#col-filter')?.addEventListener('change', e => { S.col = (e.target as HTMLSelectElement).value; render(); });
  $('#soon')?.addEventListener('click', () => showStatus('attention'));
  $('#dates-check')?.addEventListener('click', openDatesSheet);
  $('#filter-btn')?.addEventListener('click', openFilterSheet);
  $('#sel-btn')?.addEventListener('click', () => selecting ? endSelect() : startSelect());
  bindSelBar();
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
  S.tab = 'items'; if (S.view === 'grid') S.view = 'list'; S.cat = 'all'; S.loc = 'all'; S.col = 'all'; S.q = ''; S.sort = 'expiry'; S.status = status;
  render(); window.scrollTo(0, 0);
}
function openFilterSheet() {
  const draft: FilterSet = currentFilters();
  const s = sheet(`<div id="filter-body">${filterSheetHtml(draft)}</div>`, { title: 'Filter' });
  const paint = () => { $('#filter-body', s.el).innerHTML = filterSheetHtml(draft); bind(); };
  const bind = () => {
    s.el.querySelectorAll<HTMLElement>('[data-status]').forEach(b => b.onclick = () => { draft.status = b.dataset.status as StatusFilter; paint(); });
    s.el.querySelectorAll<HTMLElement>('[data-cat]').forEach(b => b.onclick = () => { draft.cat = b.dataset.cat!; paint(); });
    s.el.querySelectorAll<HTMLElement>('[data-loc]').forEach(b => b.onclick = () => { draft.loc = b.dataset.loc as FilterSet['loc']; paint(); });
    $('#f-clear', s.el).onclick = () => { draft.status = 'all'; draft.cat = 'all'; draft.loc = 'all'; paint(); };
    $('#f-apply', s.el).onclick = () => {
      S.status = draft.status; S.cat = draft.cat; S.loc = draft.loc;
      if (S.view === 'grid' && (S.cat !== 'all' || S.status !== 'all' || S.loc !== 'all')) S.view = 'list';
      s.close(); render();
    };
  };
  bind();
}
function filterSheetHtml(f: FilterSet) {
  const sc = statusCounts(f);
  const n = itemsMatching(f).length;
  const usedCats = displayCats().filter(c => active().some(i => catKey(i.categoryId) === c.id));
  const catCount = (id: string) => itemsMatching({ ...f, cat: id }).length;
  const locCount = (loc: FilterSet['loc']) => itemsMatching({ ...f, loc }).length;
  const chip = (on: boolean, extra: string, attrs: string, label: string, count: number) =>
    `<button class="chip ${extra} ${on ? 'on' : ''}" ${attrs}>${label} <span class="n">${count}</span></button>`;
  return `
    <h3 class="filter-h">Status</h3>
    <div class="chips wrap">${STATUS_CHIPS.map(([id, label, cls]) =>
      chip(statusOn(id, f.status), cls, `data-status="${id}"`, label, id === 'all' ? sc.all : id === 'noexpiry' ? sc.noexpiry : sc[id as Fresh])).join('')}</div>
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
  document.querySelectorAll<HTMLElement>('[data-cat]').forEach(b => b.onclick = () => { S.cat = b.dataset.cat!; if (S.view === 'grid') S.view = 'list'; render(); });
  document.querySelectorAll<HTMLElement>('[data-toggle]').forEach(b => b.onclick = () => {
    const id = b.dataset.toggle!;
    if (expandedCats.has(id)) expandedCats.delete(id); else expandedCats.add(id);
    $('#results').innerHTML = resultsHtml(); bindResults();
  });
  $('#clear-pantry')?.addEventListener('click', openClearPantry);
  document.querySelectorAll<HTMLElement>('.item[data-id]').forEach(li => li.onclick = () => {
    const id = li.dataset.id!;
    if (selecting) { if (selected.has(id)) selected.delete(id); else selected.add(id); paintSelection(); return; }
    editItem(S.items.find(i => i.id === id)!);
  });
  document.querySelectorAll<HTMLElement>('[data-jump-item]').forEach(li => li.onclick = () => { const it = S.items.find(i => i.id === li.dataset.jumpItem); if (it) editItem(it); });
  document.querySelectorAll<HTMLElement>('[data-jump-shop]').forEach(li => li.onclick = () => jumpToShop(li.dataset.jumpShop!));
}

// ---------- clear pantry ----------
function filterScopeText() {
  const bits: string[] = [S.col === 'all' ? 'all collections' : `the “${colOf(S.col).name}” collection`];
  if (S.cat !== 'all') bits.push(`category ${catOf(S.cat).name}`);
  if (S.loc !== 'all') bits.push(`stored in ${S.loc}`);
  if (S.status !== 'all') bits.push(STATUS_LABEL[S.status].toLowerCase());
  if (S.q.trim()) bits.push(`matching “${S.q.trim()}”`);
  return bits.join(', ');
}
/** Delete every item shown under the current filters, plus all its spend and used/binned history. */
async function clearItems(ids: Set<string>) {
  for (const id of ids) { await cancelExpiryJobs(id); await db.del('items', id); }
  const purchases = S.purchases.filter(p => p.itemId && ids.has(p.itemId));
  for (const p of purchases) await db.del('purchases', p.id);
  const events = S.events.filter(e => e.itemId && ids.has(e.itemId));
  for (const e of events) await db.del('events', e.id);
  S.items = S.items.filter(i => !ids.has(i.id));
  S.purchases = S.purchases.filter(p => !(p.itemId && ids.has(p.itemId)));
  S.events = S.events.filter(e => !(e.itemId && ids.has(e.itemId)));
  return { purchases: purchases.length, events: events.length };
}
function openClearPantry() {
  const list = itemsMatching();
  const n = list.length;
  if (!n) return toast('Nothing to clear');
  const units = list.reduce((t, i) => t + i.quantity, 0);
  const s = sheet(`<div class="warn-box">
      <p><b>This permanently deletes ${n} item${n === 1 ? '' : 's'}</b>${units !== n ? ` (quantity ${units})` : ''} from ${esc(filterScopeText())}.</p>
      <p>Their spending and used/binned history are deleted too, so they also disappear from Stats. This can't be undone.</p>
    </div>
    <p class="muted">Tip: export a backup in Settings first if you might want them back.</p>
    <div class="sheet-foot"><button class="btn ghost" data-close>Cancel</button><button class="btn danger-fill" id="clear-yes">Delete ${n} item${n === 1 ? '' : 's'}</button></div>`, { title: 'Clear pantry?' });
  $('#clear-yes', s.el).onclick = async () => {
    if (!confirm(`Delete ${n} item${n === 1 ? '' : 's'} and all their history? This can't be undone.`)) return;
    await clearItems(new Set(list.map(i => i.id)));
    s.close(); render(); toast(`Deleted ${n} item${n === 1 ? '' : 's'}`);
  };
}

// ---------- add flows ----------
function addMenu() {
  const s = sheet(`
    <button class="action" data-a="barcode"><span>📷</span><span><b>Scan barcode</b><small>Looks up the product for you</small></span></button>
    <button class="action" data-a="receipt"><span>🧾</span><span><b>Scan receipt</b><small>Adds a whole shop at once</small></span></button>
    <button class="action" data-a="manual"><span>✏️</span><span><b>Add manually</b><small>Type it in</small></span></button>`, { title: 'Add items' });
  s.el.querySelectorAll<HTMLElement>('[data-a]').forEach(b => b.onclick = () => {
    s.close();
    ({ barcode: barcodeFlow, receipt: receiptFlow, manual: () => editItem(null, {}, false, 'menu') } as any)[b.dataset.a!]();
  });
}

async function barcodeFlow() {
  const code = await (await scanner()).scanBarcode();
  if (!code) return;
  if (code === 'manual') return editItem(null, {}, false, 'barcode');
  const done = busy('Looking up product…');
  const p = await lookupBarcode(code);
  done();
  // Same barcode already in stock? Offer a quick +1 instead of a duplicate.
  const existing = active().find(i => i.barcode === code);
  if (existing && confirm(`You already have ${existing.name} (×${existing.quantity}) in ${colOf(colId(existing)).name}. Add 1 to its quantity?\n\nCancel adds it as a separate item (e.g. a different expiry).`)) {
    const nxt = { ...existing, quantity: existing.quantity + 1 };
    await saveItem(nxt);
    if (nxt.price) await recordPurchase(nxt, 1, nxt.price);
    render(); return toast(`${existing.name}: ×${nxt.quantity}`);
  }
  if (!p) toast('Product not found. Enter the details.');
  const name = p ? [p.name, p.quantity].filter(Boolean).join(' ') : '';
  const catId = name ? catKey(guessCategory(`${name} ${p?.categoriesText ?? ''}`)) : 'other';
  const paid = lastPaid({ barcode: code, name });
  editItem(null, { name, brand: p?.brand, image: p?.image, barcode: code, categoryId: catId, location: defaultLocation(catId), price: paid }, true, 'barcode');
}

const MAX_RECEIPT_PARTS = 6;
function collectReceiptParts(initial: Blob[]): Promise<Blob[] | null> {
  const parts = [...initial];
  const urls: string[] = [];
  const urlFor = (b: Blob) => { const u = URL.createObjectURL(b); urls.push(u); return u; };
  const revoke = () => { for (const u of urls) URL.revokeObjectURL(u); urls.length = 0; };
  return new Promise(resolve => {
    let settled = false;
    const s = sheet(`<p class="muted">Long receipts: photograph from top to bottom, overlapping slightly. Up to ${MAX_RECEIPT_PARTS} parts.</p>
      <div id="rp-body"></div>
      <div class="sheet-foot" id="rp-foot"></div>`, { title: 'Receipt photos', full: true, beforeClose: () => { finish(null); return true; } });
    const finish = (v: Blob[] | null) => {
      if (settled) return;
      settled = true;
      revoke();
      resolve(v);
    };
    const paint = () => {
      $('#rp-body', s.el).innerHTML = `<ul class="receipt-parts">${parts.map((b, i) => `<li>
        <img src="${urlFor(b)}" alt="Part ${i + 1}">
        <div class="rp-meta"><div class="name">Part ${i + 1}</div>
          <button type="button" class="btn ghost" data-remove="${i}">Remove</button></div></li>`).join('')}</ul>`;
      $('#rp-foot', s.el).innerHTML = `${parts.length < MAX_RECEIPT_PARTS ? '<button type="button" class="btn tonal" id="rp-add">Add another part</button>' : ''}
        <button type="button" class="btn primary" id="rp-done" ${parts.length ? '' : 'disabled'}>Done, read receipt</button>`;
      s.el.querySelectorAll<HTMLElement>('[data-remove]').forEach(b => b.onclick = () => {
        parts.splice(+b.dataset.remove!, 1);
        revoke();
        paint();
      });
      $('#rp-add', s.el)?.addEventListener('click', async () => {
        if (parts.length >= MAX_RECEIPT_PARTS) return;
        const n = parts.length + 1;
        const blob = await (await scanner()).capturePhoto('Scan receipt', `Part ${n} of ${MAX_RECEIPT_PARTS} — overlap slightly with the last photo`);
        if (!blob) return;
        parts.push(blob);
        revoke();
        paint();
      });
      $('#rp-done', s.el).onclick = () => {
        if (!parts.length) return;
        const out = [...parts];
        s.close();
        finish(out);
      };
    };
    paint();
  });
}

async function receiptFlow() {
  const first = await (await scanner()).capturePhoto('Scan receipt', 'Photograph the top of the receipt, flat and well lit. You can add more parts next.');
  if (!first) return;
  const parts = await collectReceiptParts([first]);
  if (!parts?.length) return;
  const done = busy(parts.length > 1 ? `Reading ${parts.length} receipt parts…` : 'Reading receipt…');
  let lines: { name: string; quantity: number; categoryId: string; price?: number }[] = [];
  let date: string | null = null;
  let method: 'ocr' | 'ai' = 'ocr';
  let warning = '';
  try {
    const learned = await db.getReceiptCats();
    const ocr = parseReceiptText(joinReceiptTexts(await ocrReceiptPhotos(parts)), S.cats, learned);
    lines = ocr.lines; date = ocr.date; warning = ocr.warning ?? '';
    const aiOn = S.settings.useAiScan !== false;
    if (shouldFallbackToAi(ocr, aiOn, hasKey(S.settings))) {
      const ai = await extractReceipt(S.settings, await Promise.all(parts.map(b => fileToJpeg(b, 1600, 0.85))), S.cats);
      if (ai.lines.length >= 2 || ai.lines.length > ocr.lines.length) {
        method = 'ai';
        lines = ai.lines;
        date = ai.date ?? ocr.date;
        const sum = Math.round(lines.reduce((n, l) => n + (l.price ?? 0), 0) * 100) / 100;
        warning = receiptTotalCheck(sum, ocr.total).warning ?? '';
      }
    } else if (aiOn && hasKey(S.settings)) {
      const unknown = lines.filter(l => l.categoryId === 'other').map(l => l.name);
      if (unknown.length) {
        try {
          const sug = await suggestCategories(S.settings, unknown, S.cats);
          for (const l of lines) {
            const id = sug[l.name.toLowerCase()];
            if (l.categoryId === 'other' && id) l.categoryId = id;
          }
        } catch { /* keep keyword / Other */ }
      }
    }
  } catch (e: any) { done(); return alert(e.message); }
  done();
  if (!lines.length) return toast('No items found on that receipt');
  const catOpts = (sel: string) => S.cats.map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${c.icon} ${esc(c.name)}</option>`).join('')
    + (S.cats.some(c => c.id === 'other') ? '' : `<option value="other" ${sel === 'other' ? 'selected' : ''}>${FALLBACK_CAT.icon} ${FALLBACK_CAT.name}</option>`);
  const s = sheet(`${warning ? `<div class="warn-box"><p>${esc(warning)}</p></div>` : ''}
    <div class="two">
      <div class="field"><span>Add to collection</span><select id="rv-col">${collectionOptions(db.REGULAR_ID)}</select></div>
      <label class="field"><span>Bought on</span><input id="rv-date" type="date" value="${date ?? ''}" max="${todayISO()}"><small class="muted">${date ? 'Read from the receipt' : 'Optional'}</small></label>
    </div>
    <p class="muted">${method === 'ai' ? 'Read by AI' : 'Read on your phone'}. Untick anything you don't want. Tap a name to edit it.</p>
    <ul class="review">${lines.map((l, n) => `<li data-n="${n}">
      <input type="checkbox" checked aria-label="Include">
      <div class="rv-main"><input class="rv-name" value="${esc(l.name)}"><div class="rv-sub">
        <select class="rv-cat">${catOpts(catKey(l.categoryId))}</select>
        <input class="rv-qty" type="number" min="1" inputmode="numeric" value="${l.quantity}" aria-label="Quantity">
        <input class="rv-price" type="number" min="0" step="0.01" inputmode="decimal" value="${l.price ?? ''}" placeholder="$" aria-label="Line price"></div></div></li>`).join('')}</ul>
    <div class="sheet-foot"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="rv-add">Add items</button></div>`, { full: true, title: 'Review receipt' });
  bindCollectionSelect($<HTMLSelectElement>('#rv-col', s.el));
  $('#rv-add', s.el).onclick = async () => {
    let n = 0;
    const collectionId = pickedCollection($<HTMLSelectElement>('#rv-col', s.el).value);
    const boughtOn = $<HTMLInputElement>('#rv-date', s.el).value || undefined;
    for (const li of s.el.querySelectorAll<HTMLElement>('.review li')) {
      if (!$<HTMLInputElement>('input[type=checkbox]', li).checked) continue;
      const name = $<HTMLInputElement>('.rv-name', li).value.trim(); if (!name) continue;
      const categoryId = $<HTMLSelectElement>('.rv-cat', li).value;
      const quantity = parseQty($<HTMLInputElement>('.rv-qty', li).value);
      const linePrice = parseMoney($<HTMLInputElement>('.rv-price', li).value);
      const price = linePrice != null ? Math.round(linePrice / quantity * 100) / 100 : undefined;
      const it: Item = { ...blank(), name, categoryId, location: defaultLocation(categoryId), quantity, price, collectionId, boughtOn };
      await saveItem(it);
      void db.rememberReceiptCat(name, categoryId);
      if (price) await recordPurchase(it, quantity, price, purchaseTime(boughtOn), linePrice);
      n++;
    }
    s.close(); S.tab = 'items'; render(); toast(`Added ${n} item${n === 1 ? '' : 's'} to ${colOf(collectionId).name}. Tap one to add its expiry.`);
  };
}

/** Purchases are dated on the bought-on day (midday, local) when one is given. */
function purchaseTime(boughtOn?: string) {
  if (!boughtOn || boughtOn === todayISO()) return Date.now();
  const d = localDate(boughtOn); d.setHours(12);
  return d.getTime();
}

// ---------- collections ----------
const NEW_COL = '__new__';
const pickedCollection = (v: string) => S.cols.some(c => c.id === v) ? v : db.REGULAR_ID;
function collectionOptions(sel: string) {
  return sortedCols().map(c => `<option value="${esc(c.id)}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('')
    + `<option value="${NEW_COL}">＋ New collection…</option>`;
}
/** A collection <select>; choosing "+ New collection…" asks for a name, then selects it. */
function bindCollectionSelect(sel: HTMLSelectElement, onChange?: (id: string) => void) {
  let prev = sel.value;
  sel.addEventListener('change', () => {
    if (sel.value !== NEW_COL) { prev = sel.value; onChange?.(prev); return; }
    sel.value = prev;
    openCollectionEditor(null, c => {
      sel.innerHTML = collectionOptions(c.id); sel.value = c.id; prev = c.id; onChange?.(c.id);
    });
  });
}
function openCollectionEditor(existing: Collection | null, onSaved?: (c: Collection) => void) {
  const s = sheet(`<label class="field"><span>Name</span><input id="col-name" value="${esc(existing?.name ?? '')}" placeholder="e.g. Guests – Dec" autocomplete="off"></label>
    <p class="muted">A collection is one grocery run, like a stock-up or a shop for guests.</p>
    <div class="sheet-foot"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="col-save">${existing ? 'Save' : 'Add'}</button></div>`, { title: existing ? 'Rename collection' : 'New collection' });
  $('#col-save', s.el).onclick = async () => {
    const name = $<HTMLInputElement>('#col-name', s.el).value.trim(); if (!name) return toast('Give it a name');
    if (S.cols.some(c => c.id !== existing?.id && c.name.toLowerCase() === name.toLowerCase())) return toast('You already have a collection with that name');
    const c: Collection = existing ? { ...existing, name } : { id: 'col-' + db.uid().slice(0, 8), name, createdAt: Date.now() };
    await db.put('collections', c);
    const k = S.cols.findIndex(x => x.id === c.id); if (k >= 0) S.cols[k] = c; else S.cols.push(c);
    s.close();
    if (onSaved) onSaved(c); else render();
  };
  setTimeout(() => $<HTMLInputElement>('#col-name', s.el).focus(), 300);
}
/** Delete a collection: its items and history move to Regular. Regular can't be deleted. */
async function deleteCollection(id: string) {
  if (id === db.REGULAR_ID) return;
  for (const i of S.items.filter(i => i.collectionId === id)) { i.collectionId = db.REGULAR_ID; await db.put('items', i); }
  for (const p of S.purchases.filter(p => p.collectionId === id)) { p.collectionId = db.REGULAR_ID; await db.put('purchases', p); }
  for (const e of S.events.filter(e => e.collectionId === id)) { e.collectionId = db.REGULAR_ID; await db.put('events', e); }
  await db.del('collections', id);
  S.cols = S.cols.filter(c => c.id !== id);
  if (S.col === id) S.col = 'all';
}

const blank = (): Item => ({ id: db.uid(), name: '', categoryId: 'other', collectionId: db.REGULAR_ID, location: 'Pantry', quantity: 1, addedAt: Date.now(), status: 'active' });
async function saveItem(i: Item) {
  const prev = S.items.find(x => x.id === i.id);
  const prevCat = prev?.categoryId;
  const prevCol = prev ? colId(prev) : undefined;
  if (!i.collectionId) i.collectionId = db.REGULAR_ID;
  await db.put('items', i);
  const k = S.items.findIndex(x => x.id === i.id);
  if (k >= 0) S.items[k] = i; else S.items.push(i);
  // Keep spend totals in the same category as the item the user picked.
  if (prevCat && prevCat !== i.categoryId) {
    for (const p of S.purchases.filter(x => x.itemId === i.id && x.categoryId === prevCat)) {
      p.categoryId = i.categoryId; await db.put('purchases', p);
    }
  }
  // Bought-on date changed: keep the stored date on its records in step (used if the item is deleted later).
  if (prev && prev.boughtOn !== i.boughtOn) {
    const at = db.boughtTime(i);
    for (const p of S.purchases.filter(x => x.itemId === i.id)) { p.boughtAt = at; await db.put('purchases', p); }
    for (const e of S.events.filter(x => x.itemId === i.id)) { e.boughtAt = at; await db.put('events', e); }
  }
  // Moved to another collection: its spend and used/binned history move with it.
  if (prevCol && prevCol !== i.collectionId) {
    for (const p of S.purchases.filter(x => x.itemId === i.id)) { p.collectionId = i.collectionId; await db.put('purchases', p); }
    for (const e of S.events.filter(x => x.itemId === i.id)) { e.collectionId = i.collectionId; await db.put('events', e); }
  }
  // Bought it again: tick it off the shopping list
  const same = (s: ShopItem) => !s.done && s.name.toLowerCase() === i.name.toLowerCase();
  const match = S.shop.find(s => same(s) && colId(s) === colId(i)) ?? S.shop.find(same);
  if (match && k < 0) { match.done = true; await db.put('shopping', match); }
}

function frequentCategories(exclude: string[], limit: number): Category[] {
  const stats = new Map<string, { n: number; recent: number }>();
  for (const i of active()) {
    const cur = stats.get(i.categoryId) ?? { n: 0, recent: 0 };
    cur.n++; cur.recent = Math.max(cur.recent, i.addedAt);
    stats.set(i.categoryId, cur);
  }
  const order = new Map(S.cats.map((c, i) => [c.id, i]));
  return S.cats
    .filter(c => !exclude.includes(c.id))
    .sort((a, b) => {
      const as = stats.get(a.id) ?? { n: 0, recent: 0 }, bs = stats.get(b.id) ?? { n: 0, recent: 0 };
      return bs.n - as.n || bs.recent - as.recent || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
    })
    .slice(0, limit);
}
function catQuickChips(selectedId: string) {
  const current = catOf(selectedId);
  const rest = frequentCategories([selectedId], 7);
  return [current, ...rest].map(c => `<button type="button" class="chip ${c.id === selectedId ? 'on' : ''}" data-c="${c.id}">${c.icon} ${esc(c.name)}</button>`).join('')
    + `<button type="button" class="chip more" data-cat-more>More…</button>`;
}
function openNewCategory(onCreated?: (c: Category) => void) { openCategoryEditor(null, onCreated); }
function openCategoryEditor(existing: Category | null, onSaved?: (c: Category) => void) {
  const start = existing?.icon ?? ICON_CHOICES[0];
  let icon = start;
  const custom = existing && !ICON_CHOICES.includes(start) ? start : '';
  const s = sheet(`<label class="field"><span>Name</span><input id="c-name" value="${esc(existing?.name ?? '')}" placeholder="e.g. Baby food"></label>
    <div class="field"><span>Icon</span><div class="icons">${ICON_CHOICES.map(i => `<button class="${i === start ? 'on' : ''}" data-i="${i}">${i}</button>`).join('')}</div>
    <input id="c-custom" placeholder="…or type any emoji" maxlength="4" value="${esc(custom)}"></div>
    <div class="sheet-foot"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="c-save">${existing ? 'Save' : 'Add'}</button></div>`, { title: existing ? 'Edit category' : 'New category' });
  s.el.querySelectorAll<HTMLElement>('[data-i]').forEach(b => b.onclick = () => { icon = b.dataset.i!; $<HTMLInputElement>('#c-custom', s.el).value = ''; s.el.querySelectorAll('[data-i]').forEach(x => x.classList.toggle('on', x === b)); });
  $('#c-save', s.el).onclick = async () => {
    const name = $<HTMLInputElement>('#c-name', s.el).value.trim(); if (!name) return toast('Give it a name');
    const chosen = $<HTMLInputElement>('#c-custom', s.el).value.trim() || icon;
    const c: Category = existing ? { ...existing, name, icon: chosen } : { id: 'c-' + db.uid().slice(0, 8), name, icon: chosen };
    await db.put('categories', c);
    const k = S.cats.findIndex(x => x.id === c.id); if (k >= 0) S.cats[k] = c; else S.cats.push(c);
    s.close();
    if (onSaved) onSaved(c); else render();
  };
  setTimeout(() => $<HTMLInputElement>('#c-name', s.el).focus(), 300);
}
/** Delete any category, built-in ones too. Its items and history move to Other (or Uncategorised if Other is gone). */
async function deleteCategory(id: string) {
  const to = 'other';
  if (id !== to) {
    for (const i of S.items.filter(i => i.categoryId === id)) { i.categoryId = to; await db.put('items', i); }
    for (const p of S.purchases.filter(p => p.categoryId === id)) { p.categoryId = to; await db.put('purchases', p); }
    for (const e of S.events.filter(e => e.categoryId === id)) { e.categoryId = to; await db.put('events', e); }
  }
  await db.del('categories', id);
  S.cats = S.cats.filter(c => c.id !== id);
  expandedCats.delete(id);
  if (S.cat === id) S.cat = 'all';
}
function openCategorySheet(selectedId: string, onPick: (id: string) => void) {
  let current = selectedId;
  const s = sheet(`<div class="search"><span>🔎</span><input id="cat-q" type="search" placeholder="Search categories" autocomplete="off"></div>
    <div id="cat-list"></div>
    <div class="sheet-foot"><button type="button" class="btn tonal" id="cat-new">＋ New category</button></div>`, { title: 'Category', full: true });
  const paint = () => {
    const q = $<HTMLInputElement>('#cat-q', s.el).value.trim().toLowerCase();
    const cats = [...S.cats].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
      .filter(c => !q || c.name.toLowerCase().includes(q) || c.icon.includes(q));
    $('#cat-list', s.el).innerHTML = cats.length
      ? `<ul class="cat-sheet">${cats.map(c => `<li><button type="button" class="cat-row ${c.id === current ? 'on' : ''}" data-c="${c.id}"><span class="cat-row-icon">${c.icon}</span><span class="cat-row-name">${esc(c.name)}</span>${c.id === current ? '<span class="cat-row-check">✓</span>' : ''}</button></li>`).join('')}</ul>`
      : `<div class="empty"><p>No categories match that search.</p></div>`;
    s.el.querySelectorAll<HTMLElement>('.cat-row').forEach(b => b.onclick = () => { onPick(b.dataset.c!); s.close(); });
  };
  $('#cat-q', s.el).addEventListener('input', paint);
  $('#cat-new', s.el).onclick = () => openNewCategory(c => { current = c.id; onPick(c.id); s.close(); });
  paint();
  setTimeout(() => $<HTMLInputElement>('#cat-q', s.el).focus(), 300);
}

// ---------- item editor ----------
function editItem(existing: Item | null, prefill: Partial<Item> = {}, autoCat = false, nextAdd: 'barcode' | 'menu' | 'none' | null = null) {
  const it: Item = existing ? { ...existing } : { ...blank(), ...prefill };
  let catTouched = !!existing || (!!prefill.categoryId && !autoCat);
  let dirty = false;
  const markDirty = () => { dirty = true; };
  const s = sheet(`
    ${existing ? `<div class="finish"><button class="btn used" id="e-used">✅ Used it</button><button class="btn binned" id="e-binned">🗑️ Binned it</button></div>
      <button type="button" class="btn tonal dup-btn" id="e-dup">⧉ Duplicate</button>` : ''}
    <label class="field"><span>Name</span><input id="e-name" value="${esc(it.name)}" placeholder="e.g. Greek yoghurt" autocomplete="off"></label>
    <div class="field"><span>Expiry date</span>
      <div class="date-row"><input id="e-exp" type="date" value="${it.noExpiry || it.expiryStatus === 'reading' || it.expiryStatus === 'failed' ? '' : (it.expiry ?? '')}" ${it.noExpiry ? 'disabled' : ''}><button class="btn tonal" id="e-scan">📷 Scan</button><button type="button" class="btn ghost" id="e-clear">Clear</button></div>
      <label class="toggle"><input type="checkbox" id="e-noexp" ${it.noExpiry ? 'checked' : ''}> No expiry</label>
      <small class="muted" id="e-exp-note">${expiryNote(it)}</small></div>
    <div class="field"><span>Category <small class="muted" id="e-cat-ai"></small></span><div class="cat-pick" id="e-cats"></div></div>
    <div class="field"><span>Stored in</span><div class="seg" id="e-loc">${(['Fridge', 'Freezer', 'Pantry'] as Location[]).map(l => `<button data-l="${l}" class="${it.location === l ? 'on' : ''}">${{ Fridge: '❄️', Freezer: '🧊', Pantry: '🗄️' }[l]} ${l}</button>`).join('')}</div></div>
    <div class="two">
      <div class="field"><span>Quantity</span><div class="stepper"><button data-q="-1">−</button><input id="e-qty" type="number" min="1" inputmode="numeric" value="${it.quantity}"><button data-q="1">＋</button></div></div>
      <label class="field"><span>Price (AUD)</span><input id="e-price" type="number" min="0" step="0.01" inputmode="decimal" value="${it.price ?? ''}" placeholder="Optional"><small class="muted" id="e-price-note"></small></label>
    </div>
    <div class="two">
      <div class="field"><span>Collection</span><select id="e-col">${collectionOptions(colId(it))}</select></div>
      <label class="field"><span>Bought on</span><input id="e-bought" type="date" value="${it.boughtOn ?? ''}" max="${todayISO()}"><small class="muted">Optional</small></label>
    </div>
    <details class="more"><summary>More</summary>
      <label class="field"><span>Opened on</span><input id="e-open" type="date" value="${it.opened ?? ''}"></label>
      <label class="field"><span>Brand</span><input id="e-brand" value="${esc(it.brand ?? '')}"></label>${it.barcode ? `<p class="muted">Barcode ${esc(it.barcode)}</p>` : ''}
    </details>
    <div class="sheet-foot">${existing ? '<button class="btn ghost danger" id="e-del">Delete</button>' : '<button class="btn ghost" data-close>Cancel</button>'}<button class="btn primary" id="e-save">Save</button></div>`, { full: true, title: existing ? 'Edit item' : 'New item', lead: it.image, beforeClose: async () => !dirty || await askDiscard() });
  const el = s.el;
  if (!existing) {
    const paid = it.price ?? lastPaid({ barcode: it.barcode, name: it.name });
    if (it.price == null && paid != null) { it.price = paid; $<HTMLInputElement>('#e-price', el).value = String(paid); }
    if (paid != null && it.price === paid) $('#e-price-note', el).textContent = `Last paid ${money(paid)}`;
  }
  let noExpiryTouched = !!(existing || it.noExpiry || it.expiry);
  let noExpirySuggested = !!(!existing && it.noExpiry);
  const paintExpiry = () => {
    const exp = $<HTMLInputElement>('#e-exp', el);
    const tog = $<HTMLInputElement>('#e-noexp', el);
    tog.checked = !!it.noExpiry;
    exp.disabled = !!it.noExpiry;
    if (it.noExpiry) exp.value = '';
    $('#e-exp-note', el).textContent = expiryNote(it);
  };
  const clearDate = () => {
    it.expiry = undefined; it.expiryMonthOnly = undefined; it.expiryRaw = undefined;
    if (it.expiryStatus === 'reading' || it.expiryStatus === 'pending' || it.expiryStatus === 'failed') it.expiryStatus = undefined;
    $<HTMLInputElement>('#e-exp', el).value = '';
  };
  const setNoExpiry = (on: boolean, suggested = false) => {
    it.noExpiry = on || undefined;
    if (on) {
      clearDate();
      if (existing) void cancelExpiryJobs(it.id);
    }
    if (!suggested) noExpiryTouched = true;
    else noExpirySuggested = on;
    paintExpiry();
  };
  const maybeSuggestNoExpiry = (id: string) => {
    if (existing || noExpiryTouched || $<HTMLInputElement>('#e-exp', el).value) return;
    if (id === 'household') setNoExpiry(true, true);
    else if (noExpirySuggested) setNoExpiry(false, true);
  };
  let paintCats: () => void;
  const setCat = (id: string) => {
    it.categoryId = id;
    paintCats();
    maybeSuggestNoExpiry(id);
  };
  paintCats = () => {
    $('#e-cats', el).innerHTML = catQuickChips(it.categoryId);
    $('#e-cats', el).querySelectorAll<HTMLElement>('[data-c]').forEach(b => b.onclick = () => { catTouched = true; markDirty(); setCat(b.dataset.c!); $('#e-cat-ai', el).textContent = ''; });
    $('[data-cat-more]', el).onclick = () => openCategorySheet(it.categoryId, id => { catTouched = true; markDirty(); setCat(id); $('#e-cat-ai', el).textContent = ''; });
  };
  paintCats();
  const setLocFor = (id: string) => { if (existing) return; it.location = defaultLocation(id); el.querySelectorAll<HTMLElement>('[data-l]').forEach(x => x.classList.toggle('on', x.dataset.l === it.location)); };
  el.querySelectorAll<HTMLElement>('[data-l]').forEach(b => b.onclick = () => { markDirty(); it.location = b.dataset.l as Location; el.querySelectorAll<HTMLElement>('[data-l]').forEach(x => x.classList.toggle('on', x === b)); });
  bindCollectionSelect($<HTMLSelectElement>('#e-col', el), markDirty);
  const qty = $<HTMLInputElement>('#e-qty', el);
  el.querySelectorAll<HTMLElement>('[data-q]').forEach(b => b.onclick = () => { markDirty(); qty.value = String(Math.max(1, parseQty(qty.value) + +b.dataset.q!)); });
  el.querySelectorAll('input, select, textarea').forEach(n => {
    n.addEventListener('input', markDirty);
    n.addEventListener('change', markDirty);
  });

  // Category auto-suggest: instant keyword guess, then AI if a key is set.
  const autoCategorise = async () => {
    const name = $<HTMLInputElement>('#e-name', el).value.trim();
    if (!name || catTouched) return;
    const g = catKey(guessCategory(name)); if (g !== 'other') { setCat(g); setLocFor(g); }
    if (!hasKey(S.settings)) return;
    $('#e-cat-ai', el).textContent = '· AI thinking…';
    try {
      const id = await suggestCategory(S.settings, name, S.cats);
      if (id && !catTouched) { setCat(id); setLocFor(id); $('#e-cat-ai', el).textContent = '· suggested by AI'; }
      else $('#e-cat-ai', el).textContent = '';
    } catch { $('#e-cat-ai', el).textContent = ''; }
  };
  $('#e-name', el).addEventListener('change', autoCategorise);
  if (autoCat) autoCategorise();
  if (!existing) maybeSuggestNoExpiry(it.categoryId);
  $('#e-exp', el).addEventListener('change', () => {
    dateTouched = true;
    it.expiryMonthOnly = false; it.expiryStatus = undefined; it.expiryRaw = undefined;
    if ($<HTMLInputElement>('#e-exp', el).value) setNoExpiry(false);
    else $('#e-exp-note', el).textContent = '';
  });
  // Set once the user clears, types or sets "No expiry": then a waiting/failed scan must not come back on save.
  let dateTouched = false;
  $('#e-clear', el).onclick = () => { markDirty(); dateTouched = true; it.noExpiry = undefined; noExpiryTouched = true; noExpirySuggested = false; clearDate(); if (existing) void cancelExpiryJobs(it.id); paintExpiry(); };
  $('#e-noexp', el).onchange = () => { markDirty(); dateTouched = true; setNoExpiry($<HTMLInputElement>('#e-noexp', el).checked); };

  const readForm = () => {
    const live = existing && S.items.find(x => x.id === it.id);
    if (live && !it.noExpiry && !dateTouched) {
      it.expiry = live.expiry; it.expiryMonthOnly = live.expiryMonthOnly; it.expiryRaw = live.expiryRaw; it.expiryStatus = live.expiryStatus; it.noExpiry = live.noExpiry;
    }
    it.name = $<HTMLInputElement>('#e-name', el).value.trim();
    it.noExpiry = $<HTMLInputElement>('#e-noexp', el).checked || undefined;
    if (it.noExpiry) { clearDate(); }
    else {
      const typed = $<HTMLInputElement>('#e-exp', el).value || undefined;
      if (typed) { it.expiry = typed; it.expiryStatus = undefined; it.expiryRaw = undefined; it.noExpiry = undefined; }
      else if (dateTouched) { it.expiry = undefined; it.expiryMonthOnly = undefined; it.expiryRaw = undefined; it.expiryStatus = undefined; }
      else if (it.expiryStatus !== 'reading' && it.expiryStatus !== 'pending') { it.expiry = undefined; }
    }
    it.opened = $<HTMLInputElement>('#e-open', el).value || undefined;
    it.quantity = parseQty(qty.value);
    it.price = parseMoney($<HTMLInputElement>('#e-price', el).value);
    it.brand = $<HTMLInputElement>('#e-brand', el).value.trim() || undefined;
    it.collectionId = pickedCollection($<HTMLSelectElement>('#e-col', el).value);
    it.boughtOn = $<HTMLInputElement>('#e-bought', el).value || undefined;
  };
  $('#e-scan', el).onclick = async () => {
    readForm();
    if (!it.name) { $<HTMLInputElement>('#e-name', el).focus(); return toast('Give it a name first'); }
    const blob = await captureExpiryPhoto();
    if (!blob) return;
    await startExpiryRead(it, blob);
    s.close(); S.tab = 'items'; render();
    await afterNewItem(it, existing ? null : (nextAdd ?? 'menu'), true);
  };
  $('#e-save', el).onclick = async () => {
    readForm();
    if (!it.name) { $<HTMLInputElement>('#e-name', el).focus(); return toast('Give it a name'); }
    if (it.expiry && it.expiryStatus !== 'pending') { it.expiryStatus = undefined; it.expiryRaw = undefined; }
    const added = existing ? Math.max(0, it.quantity - existing.quantity) : it.quantity;
    if (it.noExpiry) { it.expiry = undefined; it.expiryMonthOnly = undefined; it.expiryRaw = undefined; it.expiryStatus = undefined; await cancelExpiryJobs(it.id); }
    await saveItem(it);
    if (it.price && added) await recordPurchase(it, added, it.price, existing ? Date.now() : purchaseTime(it.boughtOn));
    s.close(); S.tab = 'items';
    if (!existing) await afterNewItem(it, nextAdd ?? 'menu', it.expiryStatus === 'reading');
    else { render(); toast('Saved'); }
  };
  $('#e-del', el)?.addEventListener('click', async () => {
    if (!confirm(`Delete ${it.name}?`)) return;
    await cancelExpiryJobs(it.id);
    await db.del('items', it.id); S.items = S.items.filter(x => x.id !== it.id); s.close(); render();
  });
  const finish = async (type: 'used' | 'binned') => {
    const ev: WasteEvent = { id: db.uid(), itemId: existing!.id, name: existing!.name, categoryId: existing!.categoryId, collectionId: colId(S.items.find(x => x.id === existing!.id) ?? existing!), boughtAt: db.boughtTime(existing!), type, at: Date.now(), unitPrice: existing!.price, quantity: 1 };
    await db.put('events', ev); S.events.push(ev);
    const cur = { ...(S.items.find(x => x.id === existing!.id) ?? existing!) };
    const partial = cur.quantity > 1;
    if (partial) { cur.quantity--; await saveItem(cur); }
    else { cur.status = type; cur.finishedAt = Date.now(); await cancelExpiryJobs(cur.id); await saveItem(cur); }
    // Every used/binned one goes on the shopping list under the item's collection; an open entry is kept as it is.
    const onList = S.shop.some(x => !x.done && colId(x) === colId(cur) && (x.fromItemId === cur.id || x.name.toLowerCase() === cur.name.toLowerCase()));
    if (!onList) {
      const si: ShopItem = { id: db.uid(), name: cur.name, done: false, addedAt: Date.now(), fromItemId: cur.id, collectionId: colId(cur) };
      await db.put('shopping', si); S.shop.push(si);
    }
    const what = `${type === 'used' ? 'Used' : 'Binned'} one`;
    toast(partial ? `${what}. ${cur.quantity} left · ${onList ? 'already on' : 'added to'} your shopping list` : `${cur.name} ${onList ? 'is on' : 'added to'} your shopping list`);
    s.close(); render();
  };
  // Duplicate: a new item with the same details (quantity 1), opened so he can change it before saving.
  $('#e-dup', el)?.addEventListener('click', async () => {
    if (!(await s.requestClose())) return;
    const src = S.items.find(x => x.id === existing!.id) ?? existing!;
    const final = !src.noExpiry && src.expiry && !src.expiryStatus;
    editItem(null, {
      name: src.name, brand: src.brand, image: src.image, barcode: src.barcode, categoryId: src.categoryId, collectionId: colId(src),
      location: src.location, unit: src.unit, price: src.price, boughtOn: src.boughtOn, quantity: 1,
      noExpiry: src.noExpiry, expiry: final ? src.expiry : undefined, expiryMonthOnly: final ? src.expiryMonthOnly : undefined,
    }, false, 'none');
  });
  $('#e-used', el)?.addEventListener('click', () => finish('used'));
  $('#e-binned', el)?.addEventListener('click', () => finish('binned'));
  if (!existing && !it.name) setTimeout(() => $<HTMLInputElement>('#e-name', el).focus(), 300);
}

function expiryNote(it: Item) {
  if (it.noExpiry) return 'This item does not expire.';
  if (it.expiryStatus === 'reading') return 'Reading the date in the background…';
  if (it.expiryStatus === 'failed') return "Couldn't read a date. Scan again or enter it here.";
  if (it.expiryStatus === 'pending') return 'Suggested date — confirm it from Dates to check, or edit it here.';
  if (it.expiryMonthOnly) return 'Month-only date: set to end of month';
  return '';
}
function prettyDate(iso: string, monthOnly?: boolean) {
  return monthOnly ? localDate(iso).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }) : formatDate(iso);
}

const captureExpiryPhoto = () => scanner().then(m => m.capturePhoto('Scan expiry date', 'Fill the box with the date, e.g. “BB 12/03/26”'));

async function startExpiryRead(item: Item, blob: Blob) {
  cancelledExpiryItems.delete(item.id);
  item.noExpiry = undefined; item.expiry = undefined; item.expiryMonthOnly = undefined; item.expiryRaw = undefined; item.expiryStatus = 'reading';
  await saveItem(item);
  const job: db.ExpiryJob = { id: db.uid(), itemId: item.id, photo: blob, addedAt: Date.now(), attempts: 0 };
  await db.put('expiryJobs', job);
  pumpExpiryJobs();
}
const cancelledExpiryItems = new Set<string>();
async function cancelExpiryJobs(itemId: string) {
  cancelledExpiryItems.add(itemId);
  for (const j of (await db.getAll<db.ExpiryJob>('expiryJobs')).filter(j => j.itemId === itemId)) await db.del('expiryJobs', j.id);
}

async function afterNewItem(item: Item, nextAdd: 'barcode' | 'menu' | 'none' | null, alreadyScanning: boolean) {
  render();
  if (alreadyScanning) {
    toast('Reading date… you can add another item');
    if (nextAdd === 'barcode') await barcodeFlow();
    else if (nextAdd === 'menu') addMenu();
    return;
  }
  if (item.noExpiry || (item.expiry && !item.expiryStatus)) { toast('Added'); return; }
  const choice = await offerScanExpiry(item);
  render();
  if (choice === 'done') { toast('Added'); return; }
  if (choice === 'scanned') toast('Reading date… you can add another item');
  if (nextAdd === 'barcode') await barcodeFlow();
  else if (nextAdd === 'menu') addMenu();
}
function offerScanExpiry(item: Item): Promise<'scanned' | 'skip' | 'done'> {
  return new Promise(resolve => {
    let settled = false;
    const s = sheet(`
      <p>Add a date for <b>${esc(item.name)}</b>. You can keep adding while it reads in the background.</p>
      <div class="sheet-foot"><button class="btn ghost" id="sx-skip">Not now</button><button class="btn primary" id="sx-scan">📷 Scan expiry</button></div>`, {
      title: 'Scan expiry?',
      beforeClose: () => { if (!settled) { settled = true; resolve('done'); } return true; },
    });
    const out = (v: 'scanned' | 'skip' | 'done') => { if (!settled) { settled = true; s.close(); resolve(v); } };
    $('#sx-skip', s.el).onclick = () => out('skip');
    $('#sx-scan', s.el).onclick = async () => {
      const blob = await captureExpiryPhoto();
      if (!blob) { out('skip'); return; }
      await startExpiryRead(item, blob);
      out('scanned');
    };
  });
}

async function readExpiryPhoto(blob: Blob): Promise<{ iso: string | null; monthOnly: boolean; raw: string; method?: 'ocr' | 'ai' }> {
  // 1. On-device OCR + deterministic parser.
  let raw = '';
  try {
    const o = await ocrExpiry(blob);
    raw = o.raw || o.text;
    if (o.iso) return { iso: o.iso, monthOnly: o.monthOnly, raw: o.raw, method: 'ocr' };
  } catch (e) {
    raw = String((e as Error)?.message ?? '');
  }
  // 2. AI only if no confident date, the toggle is on, and a key is set. Receipts are unchanged.
  const aiOn = S.settings.useAiScan !== false;
  if (aiOn && hasKey(S.settings)) {
    const r = await readExpiry(S.settings, await fileToJpeg(blob, 1280));
    const p = parseExpiry(r.raw);
    if (p) return { iso: p.iso, monthOnly: p.monthOnly, raw: p.raw, method: 'ai' };
    if (r.date) return { iso: r.date, monthOnly: r.monthOnly, raw: r.raw || raw, method: 'ai' };
    raw = r.raw || raw;
  }
  return { iso: null, monthOnly: false, raw, method: 'ocr' };
}
function isTransient(e: unknown) {
  if ([408, 429, 500, 502, 503, 504].includes((e as any)?.status)) return true;
  return /fail(ed)? to fetch|network|timeout|429|500|502|503|504|unavailable|overloaded|rate.?limit|temporar|offline|abort/i.test(String((e as any)?.message ?? e ?? ''));
}

const JOB_CONCURRENCY = 2;
const runningJobs = new Set<string>();
async function pumpExpiryJobs() {
  const jobs = (await db.getAll<db.ExpiryJob>('expiryJobs')).sort((a, b) => a.addedAt - b.addedAt);
  for (const job of jobs) {
    if (runningJobs.size >= JOB_CONCURRENCY) break;
    if (runningJobs.has(job.id)) continue;
    runningJobs.add(job.id);
    void runExpiryJob(job).finally(() => { runningJobs.delete(job.id); pumpExpiryJobs(); });
  }
}
async function runExpiryJob(job: db.ExpiryJob) {
  const still = () => {
    const it = S.items.find(i => i.id === job.itemId);
    return it && it.status === 'active' && it.expiryStatus === 'reading' && !it.noExpiry && !cancelledExpiryItems.has(job.itemId) ? it : null;
  };
  if (!still()) { await db.del('expiryJobs', job.id); return; }
  job.attempts++;
  await db.put('expiryJobs', job);
  try {
    const r = await readExpiryPhoto(job.photo);
    const cur = still();
    if (!cur) { await db.del('expiryJobs', job.id); return; }
    if (r.iso) { cur.expiry = r.iso; cur.expiryMonthOnly = r.monthOnly; cur.expiryRaw = r.raw || undefined; cur.expiryStatus = 'pending'; cur.expiryMethod = r.method; }
    else { cur.expiry = undefined; cur.expiryMonthOnly = undefined; cur.expiryRaw = r.raw || undefined; cur.expiryStatus = 'failed'; cur.expiryMethod = r.method; }
    await saveItem(cur);
    await db.del('expiryJobs', job.id);
    render();
    toast(r.iso ? `${cur.name}: date ready to check` : `${cur.name}: couldn't read the date`);
  } catch (e) {
    if (job.attempts < 3 && isTransient(e)) {
      await new Promise(ok => setTimeout(ok, 1500 * job.attempts));
      return;
    }
    const cur = still();
    if (cur) { cur.expiryStatus = 'failed'; await saveItem(cur); render(); }
    await db.del('expiryJobs', job.id);
  }
}
async function resumeExpiryJobs() {
  const jobs = await db.getAll<db.ExpiryJob>('expiryJobs');
  const ids = new Set(jobs.map(j => j.itemId));
  for (const it of S.items) {
    if (it.expiryStatus === 'reading' && !ids.has(it.id)) { it.expiryStatus = 'failed'; await saveItem(it); }
  }
  for (const j of jobs) {
    const it = S.items.find(i => i.id === j.itemId);
    if (!it || it.status !== 'active') await db.del('expiryJobs', j.id);
  }
  pumpExpiryJobs();
}

function openDatesSheet() {
  const s = sheet(`<div id="dates-body">${datesSheetHtml()}</div>`, { title: 'Dates to check', full: true });
  const paint = () => {
    if (!datesToCheck().length) { s.close(); render(); return; }
    $('#dates-body', s.el).innerHTML = datesSheetHtml();
    bind();
  };
  const apply = async (id: string, iso: string, monthOnly: boolean) => {
    const it = S.items.find(x => x.id === id); if (!it) return;
    it.expiry = iso; it.expiryMonthOnly = monthOnly; it.expiryStatus = undefined; it.expiryRaw = undefined; it.expiryMethod = undefined;
    await saveItem(it); render(); paint();
  };
  const bind = () => {
    s.el.querySelectorAll<HTMLElement>('[data-confirm]').forEach(b => b.onclick = () => {
      const it = S.items.find(x => x.id === b.dataset.confirm); if (!it?.expiry) return toast('Pick a date first');
      apply(it.id, it.expiry, !!it.expiryMonthOnly);
    });
    s.el.querySelectorAll<HTMLElement>('[data-edit]').forEach(b => b.onclick = () => {
      const row = b.closest('li')!; const box = $('.edit-date', row);
      box.hidden = !box.hidden; if (!box.hidden) $<HTMLInputElement>('input', box).focus();
    });
    s.el.querySelectorAll<HTMLElement>('[data-use]').forEach(b => b.onclick = () => {
      const v = $<HTMLInputElement>('input', b.closest('.edit-date')!).value; if (!v) return toast('Pick a date');
      apply(b.dataset.use!, v, false);
    });
    s.el.querySelectorAll<HTMLElement>('[data-noexp]').forEach(b => b.onclick = async () => {
      const it = S.items.find(x => x.id === b.dataset.noexp); if (!it) return;
      await setItemsNoExpiry([it]); render(); paint();
    });
    s.el.querySelectorAll<HTMLElement>('[data-retake]').forEach(b => b.onclick = async () => {
      const it = S.items.find(x => x.id === b.dataset.retake); if (!it) return;
      const blob = await captureExpiryPhoto(); if (!blob) return;
      await startExpiryRead(it, blob); render();
      if (!datesToCheck().length) { s.close(); return; }
      paint();
    });
  };
  bind();
}
/** Mark items as not expiring; also takes them out of Dates to check and stops any date read. */
async function setItemsNoExpiry(items: Item[]) {
  for (const it of items) {
    await cancelExpiryJobs(it.id);
    Object.assign(it, { noExpiry: true, expiry: undefined, expiryMonthOnly: undefined, expiryRaw: undefined, expiryStatus: undefined });
    await saveItem(it);
  }
}
function datesSheetHtml() {
  const rows = datesToCheck();
  return `<p class="muted">These dates are not final until you confirm them.</p>
    <ul class="dates-list">${rows.map(i => {
      const c = catOf(i.categoryId);
      const ok = i.expiryStatus === 'pending' && i.expiry;
      return `<li>
        <div class="thumb">${i.image ? `<img src="${esc(i.image)}" alt="">` : c.icon}</div>
        <div class="meta">
          <div class="name">${esc(i.name)}</div>
          <div class="sub">${ok ? prettyDate(i.expiry!, i.expiryMonthOnly) : "Couldn't read a date"}</div>
          ${i.expiryRaw ? `<div class="sub">Read: “${esc(i.expiryRaw.slice(0, 80))}”</div>` : ''}${i.expiryMethod ? `<div class="sub">${i.expiryMethod === 'ai' ? 'Read by AI' : 'Read on your phone'}</div>` : ''}
          <div class="edit-date" hidden><input type="date" value="${i.expiry ?? ''}"><button class="btn tonal" data-use="${i.id}">Use date</button></div>
          <div class="date-actions">
            ${ok ? `<button class="btn primary" data-confirm="${i.id}">Confirm</button>` : ''}
            <button class="btn ghost" data-edit="${i.id}">${ok ? 'Edit' : 'Enter date'}</button>
            <button class="btn ghost" data-retake="${i.id}">Retake</button>
            <button class="btn ghost" data-noexp="${i.id}">No expiry</button>
          </div>
        </div>
      </li>`;
    }).join('')}</ul>`;
}


// ---------- shopping ----------
function shopRow(s: ShopItem) {
  const src = s.fromItemId ? S.items.find(x => x.id === s.fromItemId) : undefined;
  const c = src ? catOf(src.categoryId) : undefined;
  return `<li class="item ${s.done ? 'done' : ''}" data-sid="${s.id}"><span class="check">${s.done ? '✓' : ''}</span><div class="meta"><div class="name">${esc(s.name)}</div>${c ? `<div class="sub">${c.icon} ${esc(c.name)}</div>` : ''}</div><button class="icon-btn" data-rm="${s.id}" aria-label="Remove">✕</button></li>`;
}
function shoppingView() {
  if (S.shopCol !== 'all' && !S.cols.some(c => c.id === S.shopCol)) S.shopCol = 'all';
  const inCol = S.shop.filter(s => S.shopCol === 'all' || colId(s) === S.shopCol);
  const open = inCol.filter(s => !s.done).sort((a, b) => b.addedAt - a.addedAt);
  const done = inCol.filter(s => s.done);
  const all = [...open, ...done];
  // Grouped by collection under "All collections"; one plain list when a collection is picked.
  const groups = S.shopCol === 'all' ? sortedCols().map(c => ({ c, rows: all.filter(s => colId(s) === c.id) })).filter(g => g.rows.length) : [];
  return `<header class="hdr"><h1>Shopping list</h1>${done.length ? '<button class="link" id="clear-done">Clear ticked</button>' : ''}</header>
    <div class="row-between"><span class="muted">${open.length} to buy</span>
      <select id="shop-col" class="sort col-filter" aria-label="Collection"><option value="all" ${S.shopCol === 'all' ? 'selected' : ''}>All collections</option>
      ${sortedCols().map(c => `<option value="${esc(c.id)}" ${S.shopCol === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
    <form class="search" id="add-shop"><span>＋</span><input id="shop-in" placeholder="Add to ${esc(S.shopCol === 'all' ? colOf(db.REGULAR_ID).name : colOf(S.shopCol).name)}" autocomplete="off" enterkeyhint="done"></form>
    ${all.length ? (S.shopCol === 'all'
      ? groups.map(g => `<section class="shop-group" data-shopcol="${esc(g.c.id)}"><h3 class="filter-h">${esc(g.c.name)} <span class="muted">${g.rows.filter(s => !s.done).length}</span></h3><ul class="list shop">${g.rows.map(shopRow).join('')}</ul></section>`).join('')
      : `<ul class="list shop">${all.map(shopRow).join('')}</ul>`)
      : `<div class="empty"><div class="empty-icon">🛒</div><h3>Nothing to buy</h3><p>Items you finish are added here automatically.</p></div>`}`;
}
function bindShopping() {
  $<HTMLSelectElement>('#shop-col')?.addEventListener('change', e => { S.shopCol = (e.target as HTMLSelectElement).value; render(); });
  $('#add-shop').onsubmit = async e => {
    e.preventDefault(); const v = $<HTMLInputElement>('#shop-in').value.trim(); if (!v) return;
    const si: ShopItem = { id: db.uid(), name: v, done: false, addedAt: Date.now(), collectionId: S.shopCol === 'all' ? db.REGULAR_ID : S.shopCol };
    await db.put('shopping', si); S.shop.push(si); render(); $<HTMLInputElement>('#shop-in').focus();
  };
  document.querySelectorAll<HTMLElement>('[data-sid]').forEach(li => li.onclick = async e => {
    if ((e.target as HTMLElement).closest('[data-rm]')) return;
    const si = S.shop.find(x => x.id === li.dataset.sid)!; si.done = !si.done; await db.put('shopping', si); render();
  });
  document.querySelectorAll<HTMLElement>('[data-rm]').forEach(b => b.onclick = async () => { await db.del('shopping', b.dataset.rm!); S.shop = S.shop.filter(x => x.id !== b.dataset.rm); render(); });
  $('#clear-done')?.addEventListener('click', async () => { const gone = S.shop.filter(x => x.done && (S.shopCol === 'all' || colId(x) === S.shopCol)); for (const s of gone) await db.del('shopping', s.id); S.shop = S.shop.filter(x => !gone.includes(x)); render(); });
}

// ---------- stats ----------
// Every figure is tied to when the groceries were BOUGHT (bought-on date, else the day they were added),
// so "Oct 2026" means groceries bought in October: their spend, how much was used or binned, and what is left now.
type Period = 'week' | 'month' | 'all' | string; // string = 'YYYY-MM'
const ST = { col: 'all', cat: 'all', period: 'all' as Period, from: '', to: '' }; // from/to: yyyy-mm-dd for Custom
function startOfWeek(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = x.getDay();
  x.setDate(x.getDate() - (day === 0 ? 6 : day - 1));
  return x.getTime();
}
function startOfMonth(d = new Date()) { return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }
const monthKey = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const monthLabel = (k: string) => { const [y, m] = k.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' }); };
function inPeriod(t: number, period: Period) {
  if (period === 'all') return true;
  if (period === 'week') return t >= startOfWeek();
  if (period === 'month') return t >= startOfMonth();
  if (period === 'lastmonth') { const n = new Date(); return t >= startOfMonth(new Date(n.getFullYear(), n.getMonth() - 1, 1)) && t < startOfMonth(); }
  if (period === '3m') { const n = new Date(); return t >= new Date(n.getFullYear(), n.getMonth() - 3, n.getDate()).getTime(); }
  if (period === 'custom') { // inclusive of both days; a blank end is open-ended
    const from = ST.from ? localDate(ST.from).getTime() : -Infinity;
    const to = ST.to ? localDate(ST.to).getTime() + 864e5 : Infinity;
    return t >= from && t < to;
  }
  return monthKey(t) === period;
}
type Rec = { itemId?: string; categoryId: string; collectionId?: string; at: number; boughtAt?: number };
/** A spend or used/binned record's item, category, collection and bought time (live item first, else what the record kept). */
function recInfo(r: Rec) {
  const item = r.itemId ? S.items.find(i => i.id === r.itemId) : undefined;
  return {
    cat: catKey(item?.categoryId ?? r.categoryId),
    col: colId(item ?? r),
    bought: item ? db.boughtTime(item) : r.boughtAt ?? r.at,
  };
}
type StatSel = { col: string; cat: string; period: Period };
function matchesSel(x: { cat: string; col: string; bought: number }, sel: StatSel) {
  return (sel.col === 'all' || x.col === sel.col) && (sel.cat === 'all' || x.cat === sel.cat) && inPeriod(x.bought, sel.period);
}
function statFigures(sel: StatSel) {
  const purchases = S.purchases.filter(p => matchesSel(recInfo(p), sel));
  const events = S.events.filter(e => matchesSel(recInfo(e), sel));
  const items = active().filter(i => matchesSel({ cat: catKey(i.categoryId), col: colId(i), bought: db.boughtTime(i) }, sel));
  const evSum = (type: 'used' | 'binned') => {
    const es = events.filter(e => e.type === type);
    return { n: es.reduce((t, e) => t + (e.quantity ?? 1), 0), value: es.reduce((t, e) => t + (e.unitPrice ?? 0) * (e.quantity ?? 1), 0) };
  };
  const itemSum = (list: Item[]) => ({ n: list.length, units: list.reduce((t, i) => t + i.quantity, 0), value: list.reduce((t, i) => t + (i.price ?? 0) * i.quantity, 0) });
  const byCat = new Map<string, number>();
  for (const p of purchases) { const k = recInfo(p).cat; byCat.set(k, (byCat.get(k) ?? 0) + p.total); }
  const binnedNames = new Map<string, number>();
  for (const e of events.filter(e => e.type === 'binned')) binnedNames.set(e.name, (binnedNames.get(e.name) ?? 0) + (e.quantity ?? 1));
  return {
    spent: purchases.reduce((t, p) => t + p.total, 0),
    used: evSum('used'), wasted: evSum('binned'),
    left: itemSum(items),
    soon: itemSum(items.filter(i => freshness(i) === 'soon')),
    expired: itemSum(items.filter(i => freshness(i) === 'expired')),
    byCat: [...byCat.entries()].sort((a, b) => b[1] - a[1]),
    topBinned: [...binnedNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}
/** Earlier months (before this one) that have any groceries bought in them, newest first. */
function dataMonths() {
  const keys = new Set<string>();
  for (const i of S.items) keys.add(monthKey(db.boughtTime(i)));
  for (const r of [...S.purchases, ...S.events]) keys.add(monthKey(recInfo(r).bought));
  const now = monthKey(Date.now());
  return [...keys].filter(k => k < now).sort().reverse();
}
function statsView() {
  const months = dataMonths();
  if (!['week', 'month', 'lastmonth', '3m', 'custom', 'all', ...months].includes(ST.period)) ST.period = 'all';
  if (ST.col !== 'all' && !S.cols.some(c => c.id === ST.col)) ST.col = 'all';
  if (ST.cat !== 'all' && !displayCats().some(c => c.id === ST.cat)) ST.cat = 'all';
  const f = statFigures(ST);
  const opt = (v: string, label: string, cur: string) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  const finished = f.used.n + f.wasted.n;
  const pct = finished ? Math.round((f.wasted.n / finished) * 100) : 0;
  const catMax = f.byCat[0]?.[1] ?? 0;
  const card = (cls: string, label: string, n: number, value: number, jump = '') =>
    `<${jump ? `button data-jump="${jump}"` : 'div'} class="card ${cls}"><b>${n}</b><span>${label}</span><small>${money(value)}</small></${jump ? 'button' : 'div'}>`;
  return `<header class="hdr"><h1>Stats</h1></header>
    <div class="stat-filters">
      <select id="st-col" class="sort" aria-label="Collection">${opt('all', 'All collections', ST.col)}${sortedCols().map(c => opt(c.id, c.name, ST.col)).join('')}</select>
      <select id="st-cat" class="sort" aria-label="Category">${opt('all', 'All categories', ST.cat)}${displayCats().map(c => opt(c.id, `${c.icon} ${c.name}`, ST.cat)).join('')}</select>
      <select id="st-period" class="sort" aria-label="Period">${opt('week', 'This week', ST.period)}${opt('month', 'This month', ST.period)}${opt('lastmonth', 'Last month', ST.period)}${opt('3m', 'Last 3 months', ST.period)}${months.map(m => opt(m, monthLabel(m), ST.period)).join('')}${opt('all', 'All time', ST.period)}${opt('custom', 'Custom…', ST.period)}</select>
    </div>
    ${ST.period === 'custom' ? `<div class="two stat-custom">
      <label class="field"><span>From</span><input id="st-from" type="date" value="${ST.from}"></label>
      <label class="field"><span>To</span><input id="st-to" type="date" value="${ST.to}"></label></div>` : ''}
    <p class="muted stat-note">Groceries bought in this period (by bought-on date, or the day added).</p>
    <section class="panel"><h3>Spent</h3><p class="big-money" id="st-spent">${money(f.spent)}</p>
      ${ST.cat === 'all' ? (f.byCat.length ? `<h4 class="sub-h">By category</h4>
        <ul class="spend-list">${f.byCat.map(([id, n]) => { const c = catOf(id); return `<li><span>${c.icon} ${esc(c.name)}</span><b>${money(n)}</b><i class="sbar" style="width:${catMax ? Math.max(4, (n / catMax) * 100) : 0}%"></i></li>`; }).join('')}</ul>`
        : '<p class="muted">Add a price when you save an item, or scan a receipt, to start tracking spend.</p>') : ''}
    </section>
    <div class="cards three" id="st-cards">
      ${card('', 'Used', f.used.n, f.used.value)}
      ${card('red', 'Wasted', f.wasted.n, f.wasted.value)}
      ${card('', 'Still in stock', f.left.n, f.left.value)}
      ${card('amber', 'Expiring soon', f.soon.n, f.soon.value, 'soon')}
      ${card('red', 'Expired', f.expired.n, f.expired.value, 'expired')}
    </div>
    <section class="panel"><h3>Used vs wasted</h3>
      <div class="bar"><i style="width:${finished ? 100 - pct : 100}%"></i></div>
      <p class="muted">${finished ? `You binned ${pct}% of what you finished from these groceries.` : 'Tap “Used it” or “Binned it” on an item to start tracking waste.'}</p></section>
    ${f.topBinned.length ? `<section class="panel"><h3>Most often binned</h3><ul class="plain">${f.topBinned.map(([n, c]) => `<li><span>${esc(n)}</span><b>${c}×</b></li>`).join('')}</ul></section>` : ''}`;
}
function bindStats() {
  const on = (id: string, k: keyof typeof ST) => $<HTMLSelectElement>(id)?.addEventListener('change', e => { ST[k] = (e.target as HTMLSelectElement).value; render(); });
  on('#st-col', 'col'); on('#st-cat', 'cat'); on('#st-period', 'period');
  for (const k of ['from', 'to'] as const) $<HTMLInputElement>(`#st-${k}`)?.addEventListener('change', e => { ST[k] = (e.target as HTMLInputElement).value; render(); });
  document.querySelectorAll<HTMLElement>('[data-jump]').forEach(b => b.onclick = () => {
    showStatus(b.dataset.jump as StatusFilter);
    S.col = ST.col; S.cat = ST.cat; render();
  });
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
      <label class="toggle"><input type="checkbox" id="s-ai-scan" ${st.useAiScan !== false ? 'checked' : ''}> Use AI for scanning</label>
      <p class="muted">Expiry photos and receipts are read on your phone first (works offline after the first scan). If a date can't be read, or a receipt looks incomplete, and this is on, your AI key is used as a backup.</p>
    </section>
    <section class="panel"><h3>Reminders</h3>
      <label class="field"><span>Warn me this many days before expiry</span><div class="stepper"><button data-d="-1">−</button><input id="s-days" type="number" min="0" max="30" value="${st.leadDays}"><button data-d="1">＋</button></div></label>
      <p class="muted">Notifications: <b>${({ granted: 'On', denied: 'Blocked (turn on in iPhone Settings › Notifications › Pantry)', default: 'Off', unsupported: 'Not available here. Open the app from your Home Screen.' } as Record<string, string>)[notif]}</b>. They appear when you open the app. On iPhone this needs iOS 16.4+ and the app added to your Home Screen.</p>
      ${notif === 'default' ? '<button class="btn tonal" id="s-notif">Turn on notifications</button>' : ''}
    </section>
    <section class="panel"><h3>Collections</h3>
      <p class="muted">Group items by grocery run, like a stock-up or a shop for guests. New items go to Regular unless you pick another.</p>
      <ul class="plain cats">${sortedCols().map(c => `<li><span>${esc(c.name)} <small class="muted">${active().filter(i => colId(i) === c.id).length}</small></span><span class="row-btns">
        <button class="icon-btn" data-editcol="${esc(c.id)}" aria-label="Rename ${esc(c.name)}">✎</button>
        ${c.id === db.REGULAR_ID ? '<span class="icon-btn" aria-hidden="true"></span>' : `<button class="icon-btn" data-delcol="${esc(c.id)}" aria-label="Delete ${esc(c.name)}">✕</button>`}</span></li>`).join('')}</ul>
      <button class="btn tonal" id="s-addcol">＋ New collection</button>
    </section>
    <section class="panel"><h3>Categories</h3>
      <ul class="plain cats">${S.cats.map(c => `<li><span>${c.icon} ${esc(c.name)}</span><span class="row-btns">
        <button class="icon-btn" data-editcat="${c.id}" aria-label="Edit ${esc(c.name)}">✎</button>
        <button class="icon-btn" data-delcat="${c.id}" aria-label="Delete ${esc(c.name)}">✕</button></span></li>`).join('')}</ul>
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
  $('#s-ai-scan')?.addEventListener('change', async e => { st.useAiScan = (e.target as HTMLInputElement).checked; await save(); toast(st.useAiScan ? 'AI backup for expiry and receipt scans is on' : 'Expiry and receipt scans stay on your phone'); });
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
  document.querySelectorAll<HTMLElement>('[data-editcat]').forEach(b => b.onclick = () => { const c = S.cats.find(x => x.id === b.dataset.editcat); if (c) openCategoryEditor(c); });
  document.querySelectorAll<HTMLElement>('[data-delcat]').forEach(b => b.onclick = async () => {
    const id = b.dataset.delcat!; const c = S.cats.find(x => x.id === id); if (!c) return;
    const n = active().filter(i => i.categoryId === id).length;
    const dest = id === 'other' || !S.cats.some(x => x.id === 'other') ? FALLBACK_CAT.name : catOf('other').name;
    if (!confirm(`Delete “${c.name}”?${n ? ` ${n} item${n === 1 ? '' : 's'} will move to ${dest}.` : ''}`)) return;
    await deleteCategory(id); render(); toast(`Deleted ${c.name}`);
  });
  document.querySelectorAll<HTMLElement>('[data-editcol]').forEach(b => b.onclick = () => { const c = S.cols.find(x => x.id === b.dataset.editcol); if (c) openCollectionEditor(c); });
  document.querySelectorAll<HTMLElement>('[data-delcol]').forEach(b => b.onclick = async () => {
    const id = b.dataset.delcol!; const c = S.cols.find(x => x.id === id); if (!c) return;
    const n = S.items.filter(i => i.collectionId === id).length;
    if (!confirm(`Delete “${c.name}”?${n ? ` Its ${n} item${n === 1 ? '' : 's'} and spending will move to Regular.` : ''}`)) return;
    await deleteCollection(id); render(); toast(`Deleted ${c.name}`);
  });
  $('#s-addcol').onclick = () => openCollectionEditor(null);
  $('#s-addcat').onclick = () => openNewCategory();
  $('#s-export').onclick = async () => {
    const data = JSON.stringify(await db.exportData(), null, 2);
    const file = new File([data], `pantry-backup-${todayISO()}.json`, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: 'Pantry backup' }); return; } catch { /* cancelled */ return; } }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
  };
  $<HTMLInputElement>('#s-import').addEventListener('change', async e => {
    const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
    if (!confirm('Replace everything in the app with this backup?')) return;
    try { await db.importData(JSON.parse(await f.text())); await load(); await resumeExpiryJobs(); render(); toast('Backup restored'); } catch (err: any) { alert(err.message); }
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
  const params = new URLSearchParams(location.search);
  if (params.has('demo') && !S.items.length) await seedDemo();
  await resumeExpiryJobs();
  const shot = params.get('shot');
  if (shot === 'reading' || shot === 'dates') await seedShot(shot);
  render();
  if (shot === 'receipt-parts') void showReceiptPartsShot();
  checkReminders();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { render(); checkReminders(); } });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  setTimeout(() => scanner().catch(() => {}), 3000); // warm the cache so scanning works offline
})();

/** ?demo in the URL fills an empty app with sample items (used for screenshots). */
async function seedDemo() {
  const d = (n: number) => { const x = new Date(); x.setDate(x.getDate() + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  const rows: [string, string, Location, number, number | null, number, number][] = [
    ['Full Cream Milk 2L', 'dairy', 'Fridge', 1, 2, 3.2, 2],
    ['Greek Yoghurt', 'dairy', 'Fridge', 1, -1, 5.5, 1],
    ['Baby Spinach', 'produce', 'Fridge', 1, 1, 3, 1],
    ['Chicken Thighs 500g', 'meat', 'Fridge', 1, 4, 8.5, 3],
    ['Sourdough Loaf', 'bakery', 'Pantry', 1, 6, 6, 4],
    ['Frozen Peas 1kg', 'frozen', 'Freezer', 1, 120, 3.8, 2],
    ['Spaghetti 500g', 'pantry', 'Pantry', 2, 300, 1.8, 10],
    ['Diced Tomatoes 400g', 'canned', 'Pantry', 3, 420, 1.2, 12],
    ['Tim Tams', 'snacks', 'Pantry', 1, 45, 4.5, 0],
  ];
  for (const [name, categoryId, location, quantity, days, price, boughtAgo] of rows) {
    const it = { ...blank(), name, categoryId, location, quantity, price, expiry: days === null ? undefined : d(days) };
    await saveItem(it);
    await recordPurchase(it, quantity, price, Date.now() - boughtAgo * 864e5);
  }
  const guests: Collection = { id: 'col-guests', name: 'Guests – Dec', createdAt: Date.now() };
  await db.put('collections', guests); if (!S.cols.some(c => c.id === guests.id)) S.cols.push(guests);
  for (const [name, categoryId, location, quantity, days, price] of [['Sparkling Water 10pk', 'drinks', 'Pantry', 2, 200, 7.5], ['Frozen Prawns 1kg', 'frozen', 'Freezer', 1, 90, 24]] as const) {
    const it: Item = { ...blank(), name, categoryId, location, quantity, price, expiry: d(days), collectionId: guests.id, boughtOn: todayISO() };
    await saveItem(it);
    await recordPurchase(it, quantity, price);
  }
  const salad: Purchase = { id: db.uid(), name: 'Bagged Salad', categoryId: 'produce', collectionId: db.REGULAR_ID, unitPrice: 3.5, quantity: 1, total: 3.5, at: Date.now() - 3 * 864e5 };
  await db.put('purchases', salad); S.purchases.push(salad);
  const ev: WasteEvent = { id: db.uid(), name: 'Bagged Salad', categoryId: 'produce', collectionId: db.REGULAR_ID, type: 'binned', at: Date.now() - 3 * 864e5, unitPrice: 3.5, quantity: 1 };
  await db.put('events', ev); S.events.push(ev);
  const used: WasteEvent = { id: db.uid(), name: 'Full Cream Milk 2L', categoryId: 'dairy', collectionId: db.REGULAR_ID, type: 'used', at: Date.now() - 5 * 864e5, unitPrice: 3.2, quantity: 1 };
  await db.put('events', used); S.events.push(used);
  const si: ShopItem = { id: db.uid(), name: 'Eggs', done: false, addedAt: Date.now() }; await db.put('shopping', si); S.shop.push(si);
}

async function fakeReceiptPart(label: string, lines: string[]): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = 480; c.height = 640;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f7f4ee'; g.fillRect(0, 0, 480, 640);
  g.fillStyle = '#111';
  g.font = 'bold 22px ui-monospace, monospace';
  g.fillText('WOOLWORTHS', 40, 48);
  g.font = '15px ui-monospace, monospace';
  g.fillText(label, 40, 78);
  lines.forEach((line, i) => g.fillText(line, 40, 130 + i * 28));
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('blob')), 'image/jpeg', 0.85));
}
async function showReceiptPartsShot() {
  if (!S.items.length) { await seedDemo(); render(); }
  const parts = await Promise.all([
    fakeReceiptPart('Part 1 of 3', ['Milk 2L            3.20', 'Greek Yoghurt      5.50', 'Baby Spinach       3.00']),
    fakeReceiptPart('Part 2 of 3', ['Baby Spinach       3.00', 'Chicken Thighs     8.50', 'Sourdough          6.00']),
    fakeReceiptPart('Part 3 of 3', ['Sourdough          6.00', 'Frozen Peas        3.80', 'Tim Tams           4.50']),
  ]);
  collectReceiptParts(parts);
}

/** ?demo&shot=reading|dates sets sample expiry-read states for screenshots. */
async function seedShot(shot: 'reading' | 'dates') {
  if (!S.items.length) await seedDemo();
  const milk = S.items.find(i => /milk/i.test(i.name)) ?? S.items[0];
  const yog = S.items.find(i => /yoghurt|yogurt/i.test(i.name)) ?? S.items[1];
  if (shot === 'reading') {
    Object.assign(milk, { expiry: undefined, expiryMonthOnly: undefined, expiryRaw: undefined, expiryStatus: 'reading' });
    await saveItem(milk);
  } else {
    const d = (n: number) => { const x = new Date(); x.setDate(x.getDate() + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
    Object.assign(milk, { expiry: d(2), expiryMonthOnly: false, expiryRaw: 'BB 17/11/26', expiryStatus: 'pending' });
    Object.assign(yog, { expiry: undefined, expiryMonthOnly: undefined, expiryRaw: '', expiryStatus: 'failed' });
    const spin = S.items.find(i => /spinach/i.test(i.name));
    if (spin) { Object.assign(spin, { expiry: d(1), expiryMonthOnly: false, expiryRaw: 'USE BY 16 NOV 26', expiryStatus: 'pending' }); await saveItem(spin); }
    await saveItem(milk); await saveItem(yog);
  }
}
