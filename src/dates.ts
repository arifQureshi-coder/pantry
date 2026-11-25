/**
 * Expiry date parser. Australian convention: numeric dates are DD/MM.
 * Returns ISO yyyy-mm-dd. Month-only dates resolve to the LAST day of that month.
 */
export interface ParsedDate {
  iso: string;          // yyyy-mm-dd
  monthOnly: boolean;   // e.g. "BB 03/26" or "MAR 2026"
  raw: string;          // the text fragment that matched
  keyword: boolean;     // preceded by BB / USE BY / EXP etc.
  packed?: boolean;     // preceded by Packed on / MFG etc. — not an expiry
}

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12,
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, JUNE: 6, JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
};
const MON = '(JANUARY|FEBRUARY|MARCH|APRIL|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEPT|SEP|OCT|NOV|DEC)';
const KEYWORDS = /(BEST\s*BEFORE(\s*END)?|BB[E]?|B\/B|USE\s*BY|USE\s*BEFORE|EXP(IRY|IRES|\.)?(\s*DATE)?|EXD|BEST\s*BY|BBD|SELL\s*BY|DISPLAY\s*UNTIL)\s*[:.\-]?\s*$/;
/** Dates next to these are pack/manufacture dates, not expiry. */
const PACKED = /(PACK(ED)?(\s*ON)?|PKD|MFG|MFD|MANUFACTURED|PROD(UCT(ION)?)?(\s*DATE)?|PACK\s*DATE)\s*[:.\-]?\s*$/;

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate();
const year4 = (y: number) => (y < 100 ? 2000 + y : y);

function valid(y: number, m: number, d: number) {
  return y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= lastDay(y, m);
}
export function toISO(y: number, m: number, d: number) { return `${y}-${pad(m)}-${pad(d)}`; }

/** Year missing: pick this year, or next year if that date is > 60 days in the past. */
function inferYear(m: number, d: number, today: Date) {
  const y = today.getFullYear();
  const cand = new Date(y, m - 1, d);
  return (today.getTime() - cand.getTime()) / 864e5 > 60 ? y + 1 : y;
}

/** Fix common OCR confusions inside numeric tokens (O→0, I/l→1, S→5, B→8). Letters in words are left alone. */
function normalise(text: string) {
  let t = text.toUpperCase().replace(/[‐-―]/g, '-').replace(/\s+/g, ' ');
  const swap = (ch: string, d: string) => {
    t = t.replace(new RegExp(`(?<=\\d)${ch}(?=\\d)|(?<=[\\/.\\-\\s])${ch}(?=\\d)|(?<=\\d)${ch}(?=[\\/.\\-])|(?<![A-Z0-9])${ch}(?=\\d)`, 'g'), d);
  };
  swap('O', '0');
  swap('[IL|]', '1');
  swap('S', '5');
  swap('B', '8');
  return t;
}

/** Reject dates more than 1 year in the past or more than 10 years ahead. */
export function isPlausibleDate(y: number, m: number, d: number, today = new Date()) {
  if (!valid(y, m, d)) return false;
  const dt = new Date(y, m - 1, d).getTime();
  const lo = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate()).getTime();
  const hi = new Date(today.getFullYear() + 10, today.getMonth(), today.getDate()).getTime();
  return dt >= lo && dt <= hi;
}

export function parseAllDates(input: string, today = new Date()): ParsedDate[] {
  const text = normalise(input);
  const out: ParsedDate[] = [];
  const taken: Array<[number, number]> = [];
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);

  const push = (m: RegExpExecArray, y: number, mo: number, d: number | null) => {
    const s = m.index, e = m.index + m[0].length;
    if (overlaps(s, e)) return;
    const monthOnly = d === null;
    const day = d ?? lastDay(y, mo);
    if (!valid(y, mo, day)) return;
    // A real date that's too old or too far ahead still consumes the match, so a shorter
    // re-parse of the same digits (e.g. 01/01 from 01/01/20) cannot sneak through.
    if (!isPlausibleDate(y, mo, day, today)) { taken.push([s, e]); return; }
    taken.push([s, e]);
    const before = text.slice(Math.max(0, s - 24), s);
    const packed = PACKED.test(before);
    out.push({ iso: toISO(y, mo, day), monthOnly, raw: m[0].trim(), keyword: !packed && KEYWORDS.test(before), packed });
  };
  const run = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) fn(m);
  };
  const SEP = '\\s*[\\/.\\-]\\s*';
  const B = '(?<![\\d])';   // left boundary
  const E = '(?![\\d])';    // right boundary

  // 1. ISO-ish: 2026-03-12, 2026/03/12, 2026.03.12
  run(new RegExp(`${B}(20\\d{2})${SEP}(\\d{1,2})${SEP}(\\d{1,2})${E}`, 'g'), m => push(m, +m[1], +m[2], +m[3]));
  // 2. DD/MM/YYYY or DD/MM/YY (also . - and space separated)
  run(new RegExp(`${B}(\\d{1,2})(?:${SEP}|\\s)(\\d{1,2})(?:${SEP}|\\s)(20\\d{2}|\\d{2})${E}`, 'g'), m => push(m, year4(+m[3]), +m[2], +m[1]));
  // 3. DD MON YYYY / DD-MON-YY / 12MAR26 / 12 MAR
  run(new RegExp(`${B}(\\d{1,2})(?:ST|ND|RD|TH)?\\s*[\\/.\\-]?\\s*${MON}\\.?(?:\\s*[\\/.\\-,]?\\s*(20\\d{2}|\\d{2})${E})?`, 'g'), m => {
    const mo = MONTHS[m[2]]; const d = +m[1];
    push(m, m[3] ? year4(+m[3]) : inferYear(mo, d, today), mo, d);
  });
  // 4. MON DD, YYYY (month name first, with a day)
  run(new RegExp(`${MON}\\.?\\s+(\\d{1,2})(?:ST|ND|RD|TH)?,?\\s+(20\\d{2})${E}`, 'g'), m => push(m, +m[3], MONTHS[m[1]], +m[2]));
  // 5. Month only: MAR 2026, MAR-26, MAR26
  run(new RegExp(`${MON}\\.?\\s*[\\/.\\-]?\\s*(20\\d{2}|\\d{2})${E}`, 'g'), m => push(m, year4(+m[2]), MONTHS[m[1]], null));
  // 6. Compact DDMMYY / DDMMYYYY right after a keyword (e.g. "EXP 120326")
  run(/(?:BB|BBE|EXP|USE BY|BEST BEFORE)\s*[:.]?\s*(\d{2})(\d{2})(20\d{2}|\d{2})(?!\d)/g, m => {
    const mm = { ...m, index: m.index + m[0].indexOf(m[1]) } as RegExpExecArray;
    mm[0] = m[0].slice(m[0].indexOf(m[1]));
    push(mm, year4(+m[3]), +m[2], +m[1]);
  });
  // 7. Two numbers: "03/26" → MM/YY (month-only) when 2nd part > 12; "12/03" → DD/MM, year inferred
  run(new RegExp(`${B}(\\d{1,2})${SEP}(\\d{2,4})${E}`, 'g'), m => {
    const a = +m[1], b = +m[2];
    if (m[2].length === 4) { if (b >= 2000) push(m, b, a, null); return; }   // 03/2026
    if (b > 12) push(m, year4(b), a, null);                                    // 03/26
    else push(m, inferYear(b, a, today), b, a);                                // 12/03
  });
  return out;
}

/** Pick the most likely expiry date: ignore labelled pack dates, prefer a date next to an expiry keyword, else the latest plausible one. */
export function parseExpiry(input: string, today = new Date()): ParsedDate | null {
  const found = parseAllDates(input, today);
  const all = found.some(d => !d.packed) ? found.filter(d => !d.packed) : [];
  if (!all.length) return null;
  const pool = all.some(d => d.keyword) ? all.filter(d => d.keyword) : all;
  return pool.slice().sort((a, b) => (a.iso < b.iso ? 1 : -1))[0];
}

export function daysUntil(iso: string, today = new Date()) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((new Date(y, m - 1, d).getTime() - t.getTime()) / 864e5);
}

export function formatDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}
