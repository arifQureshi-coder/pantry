import type { Settings, Category } from './types';

/**
 * AI helpers. Calls go straight from the phone to Google (Gemini) or OpenAI with the key
 * saved in Settings. No server in between.
 */
export const GEMINI_FALLBACK_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite'];

export function hasKey(s: Settings) { return s.provider === 'gemini' ? !!s.geminiKey : !!s.openaiKey; }

/** Shrink a photo before upload: faster, cheaper, and well within free-tier limits. */
export async function fileToJpeg(file: Blob, maxSide = 1600, quality = 0.85): Promise<string> {
  const bmp = await createImageBitmap(file).catch(async () => {
    const img = new Image(); img.src = URL.createObjectURL(file); await img.decode(); return img;
  });
  const w = 'naturalWidth' in bmp ? bmp.naturalWidth : bmp.width;
  const h = 'naturalHeight' in bmp ? bmp.naturalHeight : bmp.height;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d')!.drawImage(bmp as CanvasImageSource, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

function parseJSON(text: string) {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch {
    const m = t.match(/[\[{][\s\S]*[\]}]/); if (m) return JSON.parse(m[0]);
    throw new Error('AI returned something that was not JSON');
  }
}

function httpError(msg: string, status: number) {
  const e = new Error(status === 429 ? `${msg} (rate limit: wait a minute and try again)` : msg) as Error & { status: number };
  e.status = status; return e;
}

function imageList(images?: string | string[]) {
  return images == null ? [] : Array.isArray(images) ? images : [images];
}

async function callGemini(s: Settings, prompt: string, images?: string | string[]) {
  const parts: any[] = [{ text: prompt }];
  for (const url of imageList(images)) parts.push({ inline_data: { mime_type: 'image/jpeg', data: url.split(',')[1] } });
  const body = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } });
  const models = [s.geminiModel, ...GEMINI_FALLBACK_MODELS.filter(m => m !== s.geminiModel)];
  let lastErr = '', lastStatus = 0;
  for (const model of models) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.geminiKey }, body,
    });
    if (r.ok) {
      const j = await r.json();
      const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
      if (!text) throw new Error('Gemini returned no answer' + (j.promptFeedback?.blockReason ? ` (${j.promptFeedback.blockReason})` : ''));
      return parseJSON(text);
    }
    const err = await r.json().catch(() => ({}));
    lastErr = err?.error?.message || `HTTP ${r.status}`; lastStatus = r.status;
    // Only try the next model if this one is unknown/retired; key or quota errors are final.
    if (r.status !== 404 && !/not found|not supported|deprecated/i.test(lastErr)) break;
  }
  throw httpError('Gemini: ' + lastErr, lastStatus);
}

async function callOpenAI(s: Settings, prompt: string, images?: string | string[]) {
  const content: any[] = [{ type: 'text', text: prompt }];
  for (const url of imageList(images)) content.push({ type: 'image_url', image_url: { url, detail: 'high' } });
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.openaiKey}` },
    body: JSON.stringify({ model: s.openaiModel || 'gpt-4o-mini', temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'user', content }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw httpError('OpenAI: ' + (j?.error?.message || `HTTP ${r.status}`), r.status);
  return parseJSON(j.choices?.[0]?.message?.content ?? '');
}

export async function askAI(s: Settings, prompt: string, images?: string | string[]): Promise<any> {
  if (!hasKey(s)) throw new Error('Add your AI key in Settings first');
  return s.provider === 'gemini' ? callGemini(s, prompt, images) : callOpenAI(s, prompt, images);
}

const catList = (cats: Category[]) => cats.map(c => `${c.id} (${c.name})`).join(', ');

export interface ReceiptLine { name: string; quantity: number; categoryId: string; price?: number; }

function sameReceiptLine(a: ReceiptLine, b: ReceiptLine) {
  return a.name.trim().toLowerCase() === b.name.trim().toLowerCase() && (a.price ?? null) === (b.price ?? null);
}

/** Drop identical adjacent name+price lines, including leftover overlap duplicates. */
export function dedupeAdjacentReceiptLines(lines: ReceiptLine[]): ReceiptLine[] {
  const out: ReceiptLine[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (prev && sameReceiptLine(prev, line)) continue;
    out.push(line);
  }
  return out;
}

/** Join per-part lists, dropping a line only when it repeats at a part boundary. */
export function mergeReceiptParts(parts: ReceiptLine[][]): ReceiptLine[] {
  const out: ReceiptLine[] = [];
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      const line = part[i];
      if (i === 0 && out.length && sameReceiptLine(out[out.length - 1], line)) continue;
      out.push(line);
    }
  }
  return out;
}

function parseReceiptItems(j: any, cats: Category[]): ReceiptLine[] {
  const ids = new Set(cats.map(c => c.id));
  const money = (v: any) => {
    if (v == null || v === '') return undefined;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined;
  };
  return (j.items ?? j ?? []).filter((x: any) => x?.name).map((x: any) => ({
    name: String(x.name).trim(), quantity: Math.max(1, Math.round(+x.quantity || 1)), categoryId: ids.has(x.categoryId) ? x.categoryId : 'other',
    price: money(x.price),
  }));
}

export interface ReceiptRead { lines: ReceiptLine[]; date: string | null; }

/** Accept only a real yyyy-mm-dd date that is not in the future (receipts are from the past). */
export function receiptDate(v: unknown, today = new Date()): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (dt >= end || y < 2000) return null;
  return v;
}

async function extractReceiptOnce(s: Settings, images: string[], cats: Category[]): Promise<ReceiptRead> {
  const multi = images.length > 1;
  const prompt = `You are reading an Australian supermarket receipt (e.g. Woolworths, Coles, Aldi, IGA).
Extract only purchased grocery/household products. Ignore totals, subtotals, GST, discounts, savings, loyalty points, payment, change and store info.
Expand abbreviations into clear readable product names, e.g. "WW FR MLK 2L" -> "Woolworths Full Cream Milk 2L", "CC BTR 250G" -> "Coles Butter 250g", "BNNA CAVNDSH KG" -> "Cavendish Bananas".
If a line has a quantity multiplier (e.g. "2 @ $3.50" or "QTY 2") use it as quantity, otherwise 1. Merge duplicate lines by adding quantities.
For each line include "price" as the amount charged for that line in Australian dollars (the line total, not a unit price, unless only a unit price is printed). If no price is visible, use null.
Pick the best category id for each item from: ${catList(cats)}.
${multi ? `These ${images.length} photos are consecutive overlapping sections of a SINGLE receipt, photographed from top to bottom and given in order (the first image is the top). Merge them into one item list. If a product line is repeated in the overlapping area between two parts, include it only once — do not duplicate it.
` : ''}Also read the purchase date printed on the receipt as "date" in YYYY-MM-DD. Dates are Australian: numeric dates are DAY/MONTH order (12/03/26 = 12 March 2026). If no purchase date is visible, use null.
Return JSON only: {"date":string|null,"items":[{"name":string,"quantity":number,"categoryId":string,"price":number|null}]}`;
  const j = await askAI(s, prompt, images);
  return { lines: parseReceiptItems(j, cats), date: receiptDate(j?.date) };
}

export async function extractReceipt(s: Settings, image: string | string[], cats: Category[]): Promise<ReceiptRead> {
  const images = imageList(image);
  if (!images.length) return { lines: [], date: null };
  if (images.length === 1) return extractReceiptOnce(s, images, cats);
  try {
    const r = await extractReceiptOnce(s, images, cats);
    return { lines: dedupeAdjacentReceiptLines(r.lines), date: r.date };
  } catch (e) {
    // Combined request was too large or failed: read each part, then merge at the boundaries.
    const parts: ReceiptRead[] = [];
    for (const img of images) parts.push(await extractReceiptOnce(s, [img], cats));
    return { lines: mergeReceiptParts(parts.map(p => p.lines)), date: parts.find(p => p.date)?.date ?? null };
  }
}

export interface ExpiryRead { raw: string; date: string | null; monthOnly: boolean; }
export async function readExpiry(s: Settings, image: string): Promise<ExpiryRead> {
  const d = new Date(); // local (Sydney) date, not UTC: toISOString() is yesterday before 11am AEDT
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const prompt = `This photo shows part of a food package. Find the expiry, use-by or best-before date (labels like BB, BBE, Best Before, Use By, EXP, Display Until).
If several dates are shown, prefer Use By / Best Before over packed-on or manufactured dates.
Dates are Australian: numeric dates are DAY/MONTH order (12/03/26 = 12 March 2026). Two numbers like "03/26" mean MONTH/YEAR (month only).
If no year is printed, assume the next occurrence after today (${today}). For month-only dates use the last day of that month and set monthOnly true.
Return JSON only: {"raw": "<exact date text as printed, including the label>", "date": "YYYY-MM-DD" or null, "monthOnly": boolean}`;
  const j = await askAI(s, prompt, image);
  return { raw: String(j.raw ?? ''), date: /^\d{4}-\d{2}-\d{2}$/.test(j.date) ? j.date : null, monthOnly: !!j.monthOnly };
}

export async function suggestCategory(s: Settings, name: string, cats: Category[]): Promise<string | null> {
  const j = await askAI(s, `Which grocery category best fits "${name}"? Choose one id from: ${catList(cats)}. Return JSON only: {"categoryId": string}`);
  return cats.some(c => c.id === j.categoryId) ? j.categoryId : null;
}

/** One call to categorise several product names. Unknown ids are omitted. */
export async function suggestCategories(s: Settings, names: string[], cats: Category[]): Promise<Record<string, string>> {
  const list = [...new Set(names.map(n => n.trim()).filter(Boolean))].slice(0, 12);
  if (!list.length) return {};
  const j = await askAI(s, `For each grocery product, pick the best category id from: ${catList(cats)}.
Products:\n${list.map((n, i) => `${i + 1}. ${n}`).join('\n')}
Return JSON only: {"items":[{"name":string,"categoryId":string}]}`);
  const ids = new Set(cats.map(c => c.id));
  const out: Record<string, string> = {};
  for (const x of (j.items ?? [])) {
    const name = String(x?.name ?? '').trim().toLowerCase();
    const id = String(x?.categoryId ?? '');
    if (name && ids.has(id)) out[name] = id;
  }
  return out;
}
