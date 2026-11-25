/**
 * On-device supermarket receipt parser (AU). Works from OCR text: detect the
 * store, pull item lines, expand a few conservative abbreviations, and check
 * the printed total. No I/O — easy to unit test with fixture strings.
 */
import type { Category } from './types.ts';
import { parseAllDates } from './dates.ts';
import { guessCategory } from './categories.ts';
import { receiptDate, type ReceiptLine } from './ai.ts';

export type StoreId = 'woolworths' | 'coles' | 'aldi' | 'generic';
export interface ReceiptParseResult {
  store: StoreId;
  lines: ReceiptLine[];
  date: string | null;
  total: number | null;       // printed TOTAL, if found
  sum: number;                // sum of item line prices
  totalOk: boolean;           // true if no printed total, or sum is within tolerance
  warning?: string;
}

const SKIP = /^(sub\s*total|total|amount\s*due|balance\s*due|grand\s*total|gst|tax|vat|includes?\s+gst|taxable|gst\s*payable|payment|tender|cash|change|rounding|round(ed|ing)|points?|rewards?|loyalty|everyday\s*rewards|flybuys|boosters?|savings?|you\s*saved|promotion\s*savings|total\s*savings|discount\s*total|visa|mastercard|amex|american\s*express|eftpos|debit|credit|card|contactless|tap\s*(and|&)\s*go|authori[sz]ation|approval|mid\b|tid\b|abn|acn|phone|tel\b|www\.|http|thank\s*you|thanks\s*for|welcome|tax\s*invoice|invoice|receipt|docket|cashier|operator|served\s*by|store\s*#|lane\b|register|terminal|copy\s*(only)?$|signature|customer\s*copy|merchant|woohoo|low\s*prices|the\s*fresh\s*food|how\s*was|survey|receipt\s*no|txn|trans(action)?(\s*#| no)|items?\s*sold|item\s*count)/i;

const DISCOUNT = /^(you\s*)?(saved|save|price\s*reduced|reduction|discount|markdown|promo(tion)?)\b/i;
const QTY = /^(?:qty\s*)?(\d+)\s*(?:x|@|at)\s*\$?\s*(\d+[.,]\d{2})\b/i;
const WEIGHT = /^(\d+[.,]\d+)\s*(kg|g)\s*(?:net\s*)?(?:@|at)\s*\$?\s*(\d+[.,]\d{2})\s*(?:\/\s*(kg|g))?\b/i;

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
  CHSE: 'Cheese',
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
};

export function detectStore(text: string): StoreId {
  const head = text.slice(0, 600).toLowerCase();
  if (/woolworths|\bwoolies\b|\beveryday\s*rewards\b/.test(head)) return 'woolworths';
  if (/\bcoles\b|\bflybuys\b/.test(head)) return 'coles';
  if (/\baldi\b/.test(head)) return 'aldi';
  return 'generic';
}

/** Fix OCR money: O→0, S→5, l/I→1, and a decimal comma (3,20 → 3.20). */
export function parseMoneyOcr(raw: string): number | undefined {
  let t = String(raw).trim().replace(/[$\s]/g, '');
  t = t.replace(/[Oo]/g, '0').replace(/[Ss]/g, '5').replace(/[Il|]/g, '1');
  // 1,234.56 thousands, or 3,20 meaning 3.20 (OCR comma for a dot)
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d{2})$/.test(t)) t = t.replace(/,/g, '');
  else if (/^\d+,\d{2}$/.test(t)) t = t.replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n < 10000 ? Math.round(n * 100) / 100 : undefined;
}

export function expandAbbrev(name: string): string {
  let s = name.replace(/\s+/g, ' ').trim();
  s = s.replace(/\b(\d+)\s*PK\b/gi, '$1 Pack');
  s = s.split(' ').map(tok => {
    const clean = tok.replace(/[^A-Za-z]/g, '');
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
  const t = line.replace(/^[*\-•]+\s*/, '').trim();
  return SKIP.test(t);
}

function priceAtEnd(line: string): { name: string; price: number } | null {
  // Name, then a price at the end, optional GST flag (N, *, A, B) used by WW / Aldi.
  const m = line.match(/^(.*?)\s+\$?\s*(-?[\dOoSsIl|,]+[.,][\dOoSsIl]{2})\s*[N*AB]?\s*$/);
  if (!m) return null;
  const price = parseMoneyOcr(m[2].replace('-', ''));
  if (price == null) return null;
  let name = m[1].replace(/^\s*\$?\s*/, '').trim();
  // Leading SKU / PLU (5+ digits) on Woolworths / Coles lines.
  name = name.replace(/^\d{5,}\s+/, '').trim();
  if (name.length < 2) return null;
  if (isSkip(name) || DISCOUNT.test(name) || QTY.test(name) || WEIGHT.test(name)) return null;
  return { name, price };
}

function onlyPrice(line: string): number | undefined {
  const m = line.match(/^\$?\s*([\dOoSsIl|,]+[.,][\dOoSsIl]{2})\s*[N*AB]?\s*$/);
  return m ? parseMoneyOcr(m[1]) : undefined;
}

function captureTotal(line: string, into: { sub?: number; total?: number }) {
  const t = line.replace(/^[*\-•]+\s*/, '');
  const money = t.match(/\$?\s*([\dOoSsIl|,]+[.,][\dOoSsIl]{2})\s*$/);
  const amt = money ? parseMoneyOcr(money[1]) : undefined;
  if (amt == null) return false;
  if (/^sub\s*total\b/i.test(t)) { into.sub = amt; return true; }
  if (/^(grand\s*)?total\b|^amount\s*due\b|^balance\s*due\b/i.test(t) && !/savings|discount|gst|tax|points|items/i.test(t)) {
    into.total = amt; return true;
  }
  return false;
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
  const all = parseAllDates(text, today)
    .filter(d => !d.monthOnly && receiptDate(d.iso, today));
  if (!all.length) return null;
  const lines = text.split(/\r?\n/);
  const nearDate = new Set<string>();
  lines.forEach((line, i) => {
    if (/(^|\b)(date|time|docket|txn|trans)\b/i.test(line) || i < 20 || i >= lines.length - 15) {
      for (const d of parseAllDates(line, today)) if (d.iso) nearDate.add(d.iso);
    }
  });
  const pool = all.filter(d => nearDate.has(d.iso));
  const pick = (pool.length ? pool : all).slice().sort((a, b) => (a.iso < b.iso ? 1 : -1));
  return pick[0].iso;
}

export function parseReceiptText(text: string, cats: Category[] = [], learned: Record<string, string> = {}, today = new Date()): ReceiptParseResult {
  const store = detectStore(text);
  const rows = text.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const items: ReceiptLine[] = [];
  let pending = '';
  const totals: { sub?: number; total?: number } = {};
  let pastTotal = false;

  const push = (name: string, price: number, quantity = 1) => {
    const expanded = expandAbbrev(name);
    items.push({ name: expanded, quantity, price, categoryId: categorizeReceiptName(expanded, learned, cats) });
  };
  const last = () => items[items.length - 1];

  for (const raw of rows) {
    if (captureTotal(raw, totals)) { pastTotal = true; continue; }
    if (isSkip(raw)) continue;

    const qty = raw.match(QTY);
    if (qty && last()) {
      const unit = parseMoneyOcr(qty[2]);
      const n = Math.max(1, Math.round(+qty[1] || 1));
      last()!.quantity = n;
      if (unit != null) {
        const line = Math.round(unit * n * 100) / 100;
        // Keep a printed line total when it already looks like qty × unit.
        if (last()!.price == null || Math.abs((last()!.price ?? 0) - unit) < 0.009) last()!.price = line;
      }
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
    if (DISCOUNT.test(raw) && last() && !pastTotal) {
      const m = raw.match(/\$?\s*([\dOoSsIl|,]+[.,][\dOoSsIl]{2})\s*$/);
      const off = m ? parseMoneyOcr(m[1]) : undefined;
      if (off != null && last()!.price != null) {
        last()!.price = Math.round((Math.max(0, last()!.price! - off)) * 100) / 100;
      }
      continue;
    }

    const priced = priceAtEnd(raw);
    if (priced) {
      push([pending, priced.name].filter(Boolean).join(' '), priced.price);
      pending = '';
      continue;
    }
    const alone = onlyPrice(raw);
    if (alone != null && pending) {
      push(pending, alone);
      pending = '';
      continue;
    }
    if (!pastTotal && raw.length >= 3 && !/^\d+$/.test(raw) && !/^\$/.test(raw)) {
      pending = pending ? `${pending} ${raw}` : raw;
    }
  }

  const sum = Math.round(items.reduce((s, l) => s + (l.price ?? 0), 0) * 100) / 100;
  const total = totals.total ?? null;
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

/** Fall back to Gemini only when OCR is thin or the total is badly off, and only if the AI toggle is on and a key is set. */
export function shouldFallbackToAi(ocr: Pick<ReceiptParseResult, 'lines' | 'totalOk'>, useAi: boolean, hasKey: boolean): boolean {
  if (!useAi || !hasKey) return false;
  if (ocr.lines.length < 2) return true;
  if (!ocr.totalOk) return true;
  return false;
}
