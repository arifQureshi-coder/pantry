/**
 * On-device supermarket receipt parser (AU). Works from OCR text: detect the
 * store, pull item lines, expand a few conservative abbreviations, and check
 * the printed total. No I/O — easy to unit test with fixture strings.
 */
import type { Category } from './types.ts';
import { parseAllDates } from './dates.ts';
import { guessCategory } from './categories.ts';
import { receiptDate, type ReceiptLine } from './ai.ts';

export type StoreId = 'woolworths' | 'coles' | 'aldi' | 'costco' | 'generic';
export interface ReceiptParseResult {
  store: StoreId;
  lines: ReceiptLine[];
  date: string | null;
  total: number | null;       // printed TOTAL, if found
  sum: number;                // sum of item line prices
  totalOk: boolean;           // true if no printed total, or sum is within tolerance
  warning?: string;
}

const SKIP = /^(sub\s*total|total|amount\s*due|balance\s*due|grand\s*total|gst|tax|vat|includes?\s+gst|taxable|gst\s*payable|payment|tender|cash|change|rounding|round(ed|ing)|points?|rewards?|loyalty|everyday\s*rewards|flybuys|boosters?|savings?|you\s*saved|promotion\s*savings|total\s*savings|discount\s*total|visa|mastercard|amex|american\s*express|eftpos|debit|credit|card|contactless|tap\s*(and|&)\s*go|authori[sz]ation|approval|mid\b|tid\b|abn|acn|phone|tel\b|www\.|http|thank\s*you|thanks\s*for|welcome|tax\s*invoice|invoice|receipt|docket|cashier|operator|served\s*by|store\s*#|lane\b|register|terminal|copy\s*(only)?$|signature|customer\s*copy|merchant|woohoo|low\s*prices|the\s*fresh\s*food|how\s*was|survey|receipt\s*no|txn|trans(action)?(\s*#| no)|items?\s*sold|item\s*count|surcharge|card\s*sales|commonwealth|goldstar|card\s*no|reference\b|\d+\s+items?\b)/i;

const DISCOUNT = /^(you\s*)?(saved|save|price\s*reduced|reduction|discount|markdown|promo(tion)?)\b|\boffer\b/i;
const MULTIBUY = /\bany\s+(\d+)\s+for\s+\$?\s*([\dOoSsIl|,]+[.,][\dOoSsIl]{2})/i;
const QTY = /^(?:[o0q]ty\s*)?(\d+)\s*(?:x|@|at)\s*\$?\s*(\d+[.,]\d{2})\b/i;
/** "Oty 29 $7.00 each" — @ missing after a Qty/Oty word. */
const QTY_BARE = /^(?:[o0q]ty)\s+(\d+)\s+\$?\s*(\d+[.,]\d{2})\b/i;
/** Qty 2 @ $7.00 misread as "Oty 28 $7.00" (@ → 8). */
const QTY_OCR = /^(?:[o0q]ty\s+)?(\d)[84]\s*\$?\s*(\d+[.,]\d{2})\b/i;
const QTY_X = /^(\d+)\s*x\s*$/i;
/** Costco "169810 1x 12.99" or "169810 1x" after a name-only line. */
const CODE_QTY = /^(\d{4,})\s+(\d+)\s*x\s*(?:\$?\s*([\dOoSsIlC|,]+[.,][\dOoSsIl]{2}))?\s*[&N*AB]?\s*$/i;
const WEIGHT = /^(\d+[.,]\d+)\s*(kg|g)\s*(?:net\s*)?(?:@|at)\s*\$?\s*(\d+[.,]\d{2})\s*(?:\/\s*(kg|g))?\b/i;
const NOTE = /^(?:\$?\s*[\dOoSsIl|,]+[.,][\dOoSsIl]{2}|(\d+[.,]?\d*)\s*(g|kg|ml|l)|(\d+)\s*x\s*\d+([.,]\d+)?\s*(g|kg|ml|l)?)\s*$/i;

/** Conservative whole-token expansions for common AU receipt shorthand. */
const ABBREV: Record<string, string> = {
  WW: 'Woolworths', WOW: 'Woolworths',
  CC: 'Coles',
  FC: 'Full Cream', FCRM: 'Full Cream',
  LF: 'Low Fat',
  SKM: 'Skim',
  MLK: 'Milk',
  PKT: 'Packet', PKTS: 'Packets',
  BTL: 'Bottle', BTLS: 'Bottles',
  CHKN: 'Chicken', CHCKN: 'Chicken',
  BTR: 'Butter',
  BRD: 'Bread',
  BNNA: 'Banana', BNNAS: 'Bananas',
  CHSE: 'Cheese', CHS: 'Cheese',
  YGT: 'Yoghurt', YGHRT: 'Yoghurt', YGRT: 'Yoghurt',
  WTR: 'Water',
  JCE: 'Juice',
  FRZ: 'Frozen', FZN: 'Frozen',
  ORG: 'Organic', ORGNC: 'Organic',
  SCE: 'Sauce',
  HNY: 'Honey',
  SGR: 'Sugar',
  FLR: 'Flour',
  RCE: 'Rice',
  PSTA: 'Pasta',
  SPNCH: 'Spinach',
  AVO: 'Avocado', AVOS: 'Avocados',
  PRWN: 'Prawns', PRWNS: 'Prawns',
  SAUS: 'Sausage',
  BCN: 'Bacon',
  TMT: 'Tomato', TMTOS: 'Tomatoes',
  LGE: 'Large', LRG: 'Large',
  SML: 'Small',
  MED: 'Medium',
  VITMN: 'Vitamin', VIT: 'Vitamin',
  WHT: 'White',
  SLC: 'Slice', SLCS: 'Slices', SLCD: 'Sliced',
  UHT: 'UHT',
};

const STORE_LABEL: Record<StoreId, string> = {
  woolworths: 'Woolworths', coles: 'Coles', aldi: 'Aldi', costco: 'Costco', generic: 'receipt',
};

export function detectStore(text: string): StoreId {
  const head = text.slice(0, 900).toLowerCase();
  if (/\bc[o0]stco\b|\bkirkland\s+signature\b|\bwholesale\s+australia\b|\bmarsden\s+park\b/.test(head)) return 'costco';
  if (/woolworths?|\bwoolies\b|\beveryday\s*rewards\b|\bthe\s*fresh\s*food\b/.test(head)) return 'woolworths';
  if (/\bcoles\b|\bflybuys\b/.test(head)) return 'coles';
  if (/\baldi\b|\balde\s+stores\b|\blimited\s+partnership\b/.test(head)) return 'aldi';
  return 'generic';
}

/** Fix OCR money: O→0, S→5, l/I→1, and a decimal comma (3,20 → 3.20). Signed amounts allowed. */
export function parseMoneyOcr(raw: string): number | undefined {
  let t = String(raw).trim().replace(/[$\s]/g, '');
  const neg = t.startsWith('-');
  if (neg) t = t.slice(1);
  t = t.replace(/^[Cc](?=[\dOoSsIl])/, '6');
  t = t.replace(/[Oo]/g, '0').replace(/[Ss]/g, '5').replace(/[Il|]/g, '1');
  // 1,234.56 thousands, or 3,20 meaning 3.20 (OCR comma for a dot)
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d{2})$/.test(t)) t = t.replace(/,/g, '');
  else if (/^\d+,\d{2}$/.test(t)) t = t.replace(',', '.');
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n >= 10000) return undefined;
  const v = Math.round(n * 100) / 100;
  return neg ? -v : v;
}

function splitCamel(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2');
}

export function expandAbbrev(name: string, store?: StoreId): string {
  let s = splitCamel(name).replace(/\s+/g, ' ').trim();
  s = s.replace(/\b(\d+)\s*PK\b/gi, '$1 Pack');
  s = s.split(' ').map(tok => {
    const clean = tok.replace(/[^A-Za-z]/g, '');
    if (store === 'costco') {
      if (clean.toUpperCase() === 'KS') return 'Kirkland' + tok.slice(clean.length);
      if (clean.toUpperCase() === 'CHK') return 'Chicken' + tok.slice(clean.length);
    }
    const hit = ABBREV[clean.toUpperCase()];
    if (!hit || clean.length < 2) return tok;
    const punct = tok.slice(clean.length);
    return hit + punct;
  }).join(' ');
  return s.replace(/\s+/g, ' ').trim();
}

export function receiptNameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function categorizeReceiptName(name: string, learned: Record<string, string> = {}, cats?: Category[]): string {
  const key = receiptNameKey(name);
  const ids = new Set((cats ?? []).map(c => c.id));
  const valid = (id: string) => !cats?.length || ids.has(id) || id === 'other';
  if (key && learned[key] && valid(learned[key])) return learned[key];
  const g = guessCategory(name);
  return valid(g) ? g : 'other';
}

function normLine(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function similarLine(a: string, b: string) {
  const x = normLine(a), y = normLine(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 8 && y.length >= 8 && (x.includes(y) || y.includes(x))) return true;
  return false;
}

/** Join OCR texts from consecutive overlapping photos, dropping repeated boundary lines. */
export function joinReceiptTexts(parts: string[]): string {
  const chunks = parts.map(p => p.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean));
  const out: string[] = [];
  for (const lines of chunks) {
    if (!out.length) { out.push(...lines); continue; }
    let overlap = 0;
    const max = Math.min(out.length, lines.length, 12);
    for (let n = max; n >= 1; n--) {
      const a = out.slice(-n), b = lines.slice(0, n);
      if (a.every((line, i) => similarLine(line, b[i]))) { overlap = n; break; }
    }
    out.push(...lines.slice(overlap));
  }
  return out.join('\n');
}

function isSkip(line: string) {
  const t = line.replace(/^[*\-•#]+\s*/, '').trim();
  return SKIP.test(t) || /^(?:\d+\s+)?sub\s*totals?\b/i.test(t);
}

/** Store header / address / till lines — never treat as a product name. */
function isHeader(line: string) {
  const t = line.replace(/^[*\-•#]+\s*/, '').trim();
  if (!t || t === '$') return true;
  const priced = moneyOf(t) != null && !/\b(pos|trans|abn|ph:|phone|tel)\b/i.test(t);
  if (priced) return false;
  return /^(woolworths|coles|aldi|alde\s+stores|costco|the\s*fresh\s*food people)\b/i.test(t)
    || /\b(ph:|phone\b|tel\b|abn\b|acn\b|tax\s*invoice)\b/i.test(t)
    || /\bpos\s+\d+/i.test(t)
    || /\btrans\s+\d+/i.test(t)
    || /\b\d+[a-z]?\s+\w+\s+(street|st|road|rd|ave|avenue|hwy|highway|drive|dr)\b/i.test(t)
    || /^(warehouse|marsden\s+park|charlestown|merrylands|lansford)\b/i.test(t)
    || /\bgoldstar\b|\blimited\s+partnership\b|\bwholesale\b/i.test(t);
}

const MONEY_AT_END = /\$?\s*(-?[CGc]?[\dOoSsIl|,]+[.,][\dOoSsIl]{2})\s*[&N*AB]?\s*[A-Za-z0-9]{0,3}\s*$/;

function priceAtEnd(line: string): { name: string; price: number } | null {
  // Name, then a price at the end, optional GST flag (N, *, A, B) or Costco '&'.
  const m = line.match(/^(.*?)\s+\$?\s*(-?[CGc]?[\dOoSsIl|,]+[.,][\dOoSsIl]{2})\s*[&N*AB]?\s*[A-Za-z0-9]{0,3}\s*$/);
  if (!m) return null;
  const price = parseMoneyOcr(m[2]);
  if (price == null) return null;
  let name = m[1].replace(/^\s*\$?\s*/, '').replace(/^[#*•]+\s*/, '').trim();
  // Leading SKU / PLU (5+ digits) on Woolworths / Coles / Aldi / Costco lines.
  name = name.replace(/^\d{5,}\s+/, '').trim();
  if (name.length < 2) return null;
  if (isSkip(name) || DISCOUNT.test(name) || MULTIBUY.test(name) || QTY.test(name) || QTY_OCR.test(name) || WEIGHT.test(name)) return null;
  return { name, price };
}

function onlyPrice(line: string): number | undefined {
  const m = line.match(/^\$?\s*(-?[CGc]?[\dOoSsIl|,]+[.,][\dOoSsIl]{2})\s*[&N*AB]?\s*[A-Za-z0-9]{0,3}\s*$/);
  return m ? parseMoneyOcr(m[1]) : undefined;
}

function moneyOf(line: string): number | undefined {
  const m = line.match(MONEY_AT_END);
  return m ? parseMoneyOcr(m[1]) : undefined;
}

function captureTotal(line: string, into: { sub?: number; total?: number; pay?: number }) {
  const t = line.replace(/^[*\-•]+\s*/, '');
  const loose = t.match(/(-?\d+[.,]\d{1,2})\s*$/);
  const amt = moneyOf(t) ?? (loose ? parseMoneyOcr(loose[1]) : undefined);
  if (amt == null || amt < 0) return false;
  if (/^(?:\d+\s+)?sub\s*totals?\b/i.test(t)) { into.sub = amt; return true; }
  if (/^(card\s*sales|eftpos)\b/i.test(t)) { into.pay = amt; return true; }
  const looksTotal = /^(?:[A-Za-z0-9]{1,4}\s+)?(?:\d+\s+)?(grand\s*)?total\b|^amount\s*due\b|^balance\s*due\b/i.test(t);
  if (!looksTotal) return false;
  // Allow "Total (INCL GST)" but not TOTAL SAVINGS / TOTAL SURCHARGE / TOTAL GST.
  if (/\b(savings|discount|surcharge|points|items)\b/i.test(t)) return false;
  if (/\bgst\b/i.test(t) && !/\bincl/i.test(t)) return false;
  into.total = amt;
  return true;
}

export function receiptTotalCheck(sum: number, total: number | null): { ok: boolean; warning?: string } {
  if (total == null || !(total > 0)) return { ok: true };
  const diff = Math.round(Math.abs(sum - total) * 100) / 100;
  const tol = Math.max(1, Math.round(total * 0.02 * 100) / 100);
  if (diff > tol) {
    const money = (n: number) => n.toFixed(2);
    return { ok: false, warning: `Items add up to $${money(sum)}, but the receipt total is $${money(total)}. Check the list before adding.` };
  }
  return { ok: true };
}

export function receiptPurchaseDate(text: string, today = new Date()): string | null {
  const all = parseAllDates(text, today, 8)
    .filter(d => !d.monthOnly && receiptDate(d.iso, today));
  if (!all.length) return null;
  const lines = text.split(/\r?\n/);
  const nearDate = new Set<string>();
  lines.forEach((line, i) => {
    if (/(^|\b)(date|time|docket|txn|trans)\b/i.test(line) || i < 20 || i >= lines.length - 15) {
      for (const d of parseAllDates(line, today, 8)) if (d.iso) nearDate.add(d.iso);
    }
  });
  const pool = all.filter(d => nearDate.has(d.iso));
  const pick = (pool.length ? pool : all).slice().sort((a, b) => (a.iso < b.iso ? 1 : -1));
  return pick[0].iso;
}

function applyAmountOff(item: ReceiptLine, off: number) {
  if (item.price == null || off <= 0) return;
  item.price = Math.round(Math.max(0, item.price - off) * 100) / 100;
}

/** Spread a Woolworths-style "ANY N for $X" saving across the preceding items that fit the deal. */
function applyMultibuy(items: ReceiptLine[], n: number, dealPrice: number, off: number) {
  if (!items.length || off <= 0 || n < 2 || dealPrice <= 0) return;
  const start = Math.max(0, items.length - 12);
  const window = items.slice(start);
  const m = window.length;
  let best: number[] | null = null;
  let bestScore = -1;
  for (let mask = 1; mask < (1 << m); mask++) {
    let qty = 0, sum = 0;
    const chosen: number[] = [];
    let skip = false;
    for (let i = 0; i < m; i++) if (mask & (1 << i)) {
      const it = window[i];
      const q = Math.max(1, it.quantity || 1);
      const unit = (it.price ?? 0) / q;
      if (unit <= dealPrice / n + 0.009) { skip = true; break; }
      qty += q;
      sum += it.price ?? 0;
      chosen.push(start + i);
    }
    if (skip) continue;
    if (qty < n || qty % n !== 0) continue;
    const save = Math.round((sum - (qty / n) * dealPrice) * 100) / 100;
    if (Math.abs(save - off) > 0.02) continue;
    const names = chosen.map(i => receiptNameKey(items[i].name).split(' '));
    const tokens = new Map<string, number>();
    for (const ns of names) for (const t of ns) if (t.length >= 3) tokens.set(t, (tokens.get(t) || 0) + 1);
    const shared = [...tokens.values()].filter(c => c >= 2).reduce((a, b) => a + b, 0);
    const near = chosen.reduce((s, i) => s + (i - start), 0);
    const score = shared * 10 + near;
    if (score > bestScore) { bestScore = score; best = chosen; }
  }
  if (!best) {
    applyAmountOff(items[items.length - 1], off);
    return;
  }
  const sum = best.reduce((s, i) => s + (items[i].price ?? 0), 0);
  if (sum <= 0) return;
  let allocated = 0;
  best.forEach((i, k) => {
    const part = k === best!.length - 1
      ? Math.round((off - allocated) * 100) / 100
      : Math.round(((items[i].price ?? 0) / sum) * off * 100) / 100;
    allocated += part;
    applyAmountOff(items[i], part);
  });
}

function resolveQty(n: number, unit: number | undefined, printed: number | undefined): { qty: number; line: number | undefined } {
  if (unit == null) return { qty: n, line: printed };
  const exact = Math.round(unit * n * 100) / 100;
  if (printed != null && Math.abs(printed - exact) < 0.02) return { qty: n, line: printed };
  // "Oty 28 $7.00" with a printed 14.00 → qty 2 @ $7.00
  if (n >= 10 && n <= 99) {
    const n1 = Math.floor(n / 10);
    const alt = Math.round(unit * n1 * 100) / 100;
    if (printed != null && Math.abs(printed - alt) < 0.02) return { qty: n1, line: printed };
    if (n1 >= 1 && n1 <= 9 && n % 10 === 8) return { qty: n1, line: printed ?? alt };
  }
  return { qty: n, line: exact };
}


function closeAmt(a: number, b: number) {
  return Math.abs(a - b) <= Math.max(1, Math.round(Math.max(a, b) * 0.02 * 100) / 100);
}

function pickPrintedTotal(totals: { sub?: number; total?: number; pay?: number }, sum: number): number | null {
  const t = totals.total, s = totals.sub, p = totals.pay;
  // Card Sales / EFTPOS that agrees with SUBTOTAL (or a small surcharge) beats a garbled TOTAL like $53.48 vs $63.17.
  if (p != null && s != null && closeAmt(p, s)) return p;
  if (p != null && t != null && s != null && !closeAmt(t, s) && (closeAmt(p, s) || (sum > 0 && Math.abs(sum - p) < Math.abs(sum - t)))) return p;
  if (p != null && t == null && s != null && p >= s - 0.02 && p - s <= Math.max(1, s * 0.05)) return p;
  if (t != null && s != null) {
    const far = !closeAmt(t, s);
    if (far) {
      const lo = Math.min(t, s), hi = Math.max(t, s);
      // A garbled TOTAL like "5.45" next to SUBTOTAL $85.95 — keep the larger amount.
      if (lo < hi * 0.2) {
        if (sum > 0 && closeAmt(sum, lo)) return lo;
        return hi;
      }
      if (sum > 0) return Math.abs(sum - t) <= Math.abs(sum - s) ? t : s;
      return t;
    }
    return t;
  }
  return t ?? s ?? p ?? null;
}

export function parseReceiptText(text: string, cats: Category[] = [], learned: Record<string, string> = {}, today = new Date()): ReceiptParseResult {
  const store = detectStore(text);
  const rows = text.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const items: ReceiptLine[] = [];
  let pending = '';
  let pendingQty: number | null = null;
  const totals: { sub?: number; total?: number; pay?: number } = {};
  let pastTotal = false;

  const push = (name: string, price: number, quantity = 1) => {
    const expanded = expandAbbrev(name, store);
    items.push({ name: expanded, quantity, price, categoryId: categorizeReceiptName(expanded, learned, cats) });
  };
  const last = () => items[items.length - 1];

  const applyQty = (nRaw: number, unit: number | undefined) => {
    const item = last();
    if (!item) return false;
    const { qty, line } = resolveQty(Math.max(1, Math.round(nRaw || 1)), unit, item.price);
    item.quantity = qty;
    if (line != null) {
      // Keep a printed line total when it already looks like qty × unit; otherwise, if the
      // name line was the unit price, replace it with the line total.
      if (item.price == null || Math.abs((item.price ?? 0) - (unit ?? -1)) < 0.009) item.price = line;
    }
    return true;
  };

  for (const raw of rows) {
    if (captureTotal(raw, totals)) { pastTotal = true; continue; }
    if (isSkip(raw)) continue;
    if (NOTE.test(raw) && !pending) continue;

    if (isHeader(raw)) { pending = ''; continue; }

    const qty = raw.match(QTY) || raw.match(QTY_OCR) || raw.match(QTY_BARE);
    if (qty) {
      const unit = parseMoneyOcr(qty[2]);
      const nRaw = +qty[1];
      const endPrice = moneyOf(raw);
      const printed = endPrice != null && (unit == null || Math.abs(endPrice - unit) > 0.009) ? endPrice : undefined;
      if (pending) {
        const { qty: q, line } = resolveQty(Math.max(1, Math.round(nRaw || 1)), unit, printed);
        if (line != null) {
          push(pending, line, q);
          pending = '';
          pendingQty = null;
          continue;
        }
      }
      if (last()) {
        applyQty(nRaw, unit);
        continue;
      }
    }
    const qOnly = raw.match(QTY_X);
    if (qOnly) {
      const n = Math.max(1, Math.round(+qOnly[1] || 1));
      if (last() && !pending) last()!.quantity = n;
      else pendingQty = n;
      continue;
    }
    const codeQty = raw.match(CODE_QTY);
    if (codeQty) {
      const n = Math.max(1, Math.round(+codeQty[2] || 1));
      const unit = codeQty[3] ? parseMoneyOcr(codeQty[3]) : undefined;
      if (pending && unit != null) {
        push(pending, unit, n);
        pending = '';
        pendingQty = null;
        continue;
      }
      pendingQty = n;
      continue;
    }
    const wt = raw.match(WEIGHT);
    if (wt && last()) {
      const w = parseMoneyOcr(wt[1].replace(',', '.')) ?? Number(wt[1].replace(',', '.'));
      const unit = parseMoneyOcr(wt[3]);
      if (unit != null && Number.isFinite(w) && w > 0) {
        const line = Math.round(w * unit * 100) / 100;
        last()!.quantity = 1;
        if (last()!.price == null || Math.abs((last()!.price ?? 0) - unit) < 0.009) last()!.price = line;
      }
      continue;
    }

    const offAmt = (() => {
      const v = moneyOf(raw);
      return v != null && v < 0 ? -v : (v != null && (DISCOUNT.test(raw) || MULTIBUY.test(raw)) ? v : undefined);
    })();
    if (offAmt != null && last() && !pastTotal && (DISCOUNT.test(raw) || MULTIBUY.test(raw) || /^-/.test(raw.trim()) || (priceAtEnd(raw)?.price ?? 0) < 0)) {
      const mb = raw.match(MULTIBUY);
      if (mb) {
        const n = Math.max(2, Math.round(+mb[1] || 2));
        const deal = parseMoneyOcr(mb[2]);
        if (deal != null) applyMultibuy(items, n, deal, offAmt);
        else applyAmountOff(last()!, offAmt);
      } else {
        applyAmountOff(last()!, offAmt);
      }
      continue;
    }

    const priced = priceAtEnd(raw);
    if (priced && priced.price < 0 && last() && !pastTotal) {
      applyAmountOff(last()!, -priced.price);
      pending = '';
      continue;
    }
    if (priced && priced.price >= 0) {
      const q = pendingQty ?? 1;
      pendingQty = null;
      // A new SKU line is a new item — don't glue a previous name-only line onto it.
      const name = /^\d{5,}/.test(raw) ? priced.name : [pending, priced.name].filter(Boolean).join(' ');
      push(name, priced.price, q);
      pending = '';
      continue;
    }
    const alone = onlyPrice(raw);
    if (alone != null && alone < 0 && last() && !pastTotal) {
      applyAmountOff(last()!, -alone);
      continue;
    }
    if (alone != null && alone >= 0 && pending) {
      const q = pendingQty ?? 1;
      pendingQty = null;
      push(pending, alone, q);
      pending = '';
      continue;
    }
    if (!pastTotal && raw.length >= 3 && !/^\d+$/.test(raw) && !/^\$/.test(raw) && !NOTE.test(raw) && !isHeader(raw)) {
      const name = raw.replace(/^[#*•]+\s*/, '').replace(/^\d{5,}\s+/, '').trim();
      if (name.length >= 2 && !isSkip(name)) pending = pending ? `${pending} ${name}` : name;
    }
  }

  const sum = Math.round(items.reduce((s, l) => s + (l.price ?? 0), 0) * 100) / 100;
  const total = pickPrintedTotal(totals, sum);
  const check = receiptTotalCheck(sum, total);
  return {
    store,
    lines: items,
    date: receiptPurchaseDate(text, today),
    total, sum,
    totalOk: check.ok,
    warning: check.warning,
  };
}

function emptyResult(today = new Date()): ReceiptParseResult {
  return { store: 'generic', lines: [], date: null, total: null, sum: 0, totalOk: true };
}

/** Parse one or more OCR texts: join overlapping parts of the same shop, or merge distinct receipts with a warning. */
export function parseReceiptParts(texts: string[], cats: Category[] = [], learned: Record<string, string> = {}, today = new Date()): ReceiptParseResult {
  const parts = texts.map(t => t.trim()).filter(Boolean);
  if (!parts.length) return emptyResult(today);
  if (parts.length === 1) return parseReceiptText(parts[0], cats, learned, today);

  const parsed = parts.map(t => parseReceiptText(t, cats, learned, today));
  const known = new Set(parsed.map(p => p.store).filter(s => s !== 'generic'));
  const totals = parsed.map(p => p.total).filter((t): t is number => t != null && t > 0);
  const uniqueTot = [...new Set(totals.map(t => t.toFixed(2)))];
  // Same shop, at most one distinct printed total (or overlap that repeated it) → one receipt.
  if (known.size <= 1 && uniqueTot.length <= 1) {
    return parseReceiptText(joinReceiptTexts(parts), cats, learned, today);
  }
  return mergeParsedReceipts(parsed);
}

function mergeParsedReceipts(parsed: ReceiptParseResult[]): ReceiptParseResult {
  const lines = parsed.flatMap(p => p.lines);
  const sum = Math.round(lines.reduce((s, l) => s + (l.price ?? 0), 0) * 100) / 100;
  const totals = parsed.map(p => p.total).filter((t): t is number => t != null && t > 0);
  const total = totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) * 100) / 100 : null;
  const check = receiptTotalCheck(sum, total);
  const labels = parsed.filter(p => p.lines.length || p.total != null).map(p => {
    const name = STORE_LABEL[p.store];
    return p.total != null ? `${name} $${p.total.toFixed(2)}` : name;
  });
  const multi = labels.length > 1
    ? `This photo looks like ${labels.length} receipts (${labels.join(' and ')}). Check the list before adding.`
    : '';
  const warning = [multi, check.warning].filter(Boolean).join(' ') || undefined;
  const stores = parsed.map(p => p.store).filter(s => s !== 'generic');
  return {
    store: stores.length === 1 ? stores[0] : (stores[0] ?? 'generic'),
    lines,
    date: parsed.map(p => p.date).find(Boolean) ?? null,
    total, sum,
    totalOk: check.ok,
    warning,
  };
}

/** Fall back to Gemini only when OCR is thin or the total is badly off, and only if the AI toggle is on and a key is set. */
export function shouldFallbackToAi(ocr: Pick<ReceiptParseResult, 'lines' | 'totalOk'>, useAi: boolean, hasKey: boolean): boolean {
  if (!useAi || !hasKey) return false;
  if (ocr.lines.length < 2) return true;
  if (!ocr.totalOk) return true;
  return false;
}
