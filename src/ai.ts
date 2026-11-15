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

async function callGemini(s: Settings, prompt: string, imageDataUrl?: string) {
  const parts: any[] = [{ text: prompt }];
  if (imageDataUrl) parts.push({ inline_data: { mime_type: 'image/jpeg', data: imageDataUrl.split(',')[1] } });
  const body = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } });
  const models = [s.geminiModel, ...GEMINI_FALLBACK_MODELS.filter(m => m !== s.geminiModel)];
  let lastErr = '';
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
    lastErr = err?.error?.message || `HTTP ${r.status}`;
    // Only try the next model if this one is unknown/retired; key or quota errors are final.
    if (r.status !== 404 && !/not found|not supported|deprecated/i.test(lastErr)) break;
  }
  throw new Error('Gemini: ' + lastErr);
}

async function callOpenAI(s: Settings, prompt: string, imageDataUrl?: string) {
  const content: any[] = [{ type: 'text', text: prompt }];
  if (imageDataUrl) content.push({ type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } });
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.openaiKey}` },
    body: JSON.stringify({ model: s.openaiModel || 'gpt-4o-mini', temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'user', content }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('OpenAI: ' + (j?.error?.message || `HTTP ${r.status}`));
  return parseJSON(j.choices?.[0]?.message?.content ?? '');
}

export async function askAI(s: Settings, prompt: string, imageDataUrl?: string): Promise<any> {
  if (!hasKey(s)) throw new Error('Add your AI key in Settings first');
  return s.provider === 'gemini' ? callGemini(s, prompt, imageDataUrl) : callOpenAI(s, prompt, imageDataUrl);
}

const catList = (cats: Category[]) => cats.map(c => `${c.id} (${c.name})`).join(', ');

export interface ReceiptLine { name: string; quantity: number; categoryId: string; }
export async function extractReceipt(s: Settings, image: string, cats: Category[]): Promise<ReceiptLine[]> {
  const prompt = `You are reading an Australian supermarket receipt (e.g. Woolworths, Coles, Aldi, IGA).
Extract only purchased grocery/household products. Ignore totals, subtotals, GST, discounts, savings, loyalty points, payment, change and store info.
Expand abbreviations into clear readable product names, e.g. "WW FR MLK 2L" -> "Woolworths Full Cream Milk 2L", "CC BTR 250G" -> "Coles Butter 250g", "BNNA CAVNDSH KG" -> "Cavendish Bananas".
If a line has a quantity multiplier (e.g. "2 @ $3.50" or "QTY 2") use it as quantity, otherwise 1. Merge duplicate lines by adding quantities.
Pick the best category id for each item from: ${catList(cats)}.
Return JSON only: {"items":[{"name":string,"quantity":number,"categoryId":string}]}`;
  const j = await askAI(s, prompt, image);
  const ids = new Set(cats.map(c => c.id));
  return (j.items ?? j ?? []).filter((x: any) => x?.name).map((x: any) => ({
    name: String(x.name).trim(), quantity: Math.max(1, Math.round(+x.quantity || 1)), categoryId: ids.has(x.categoryId) ? x.categoryId : 'other',
  }));
}

export interface ExpiryRead { raw: string; date: string | null; monthOnly: boolean; }
export async function readExpiry(s: Settings, image: string): Promise<ExpiryRead> {
  const today = new Date().toISOString().slice(0, 10);
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
