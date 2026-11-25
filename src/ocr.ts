/**
 * On-device expiry OCR with Tesseract.js. Assets live under ./ocr/ and are
 * lazy-loaded on the first scan so startup stays fast; the service worker
 * then caches them for offline use.
 */
import { parseExpiry } from './dates';

const asset = (p: string) => new URL(`ocr/${p}`, document.baseURI).href;

async function loadBitmap(img: Blob): Promise<ImageBitmap | HTMLImageElement> {
  return createImageBitmap(img).catch(async () => {
    const i = new Image();
    i.src = URL.createObjectURL(img);
    await i.decode();
    URL.revokeObjectURL(i.src);
    return i;
  });
}

function sizeOf(bmp: ImageBitmap | HTMLImageElement) {
  const w = 'naturalWidth' in bmp ? bmp.naturalWidth : bmp.width;
  const h = 'naturalHeight' in bmp ? bmp.naturalHeight : bmp.height;
  return { w, h };
}

function toBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('preprocess')), 'image/png'));
}

function lumaAt(d: Uint8ClampedArray, i: number) {
  return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
}

/** Crop to the on-screen date box (10% sides, 32% from top, 22% tall), then greyscale, boost contrast and upscale. */
export async function preprocessExpiryPhoto(img: Blob, crop = true): Promise<Blob> {
  const bmp = await loadBitmap(img);
  const { w, h } = sizeOf(bmp);
  let sx = 0, sy = 0, sw = w, sh = h;
  // Full-frame camera shots are wide; close-up library photos are left intact.
  if (crop && w >= 900 && w / h >= 1.2) {
    sx = Math.round(w * 0.10); sy = Math.round(h * 0.32);
    sw = Math.round(w * 0.80); sh = Math.round(h * 0.22);
  }
  const scale = Math.min(3, Math.max(1, 1200 / Math.max(sw, sh)));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = true;
  g.drawImage(bmp as CanvasImageSource, sx, sy, sw, sh, 0, 0, c.width, c.height);
  contrastStretch(g, c.width, c.height);
  return toBlob(c);
}

function contrastStretch(g: CanvasRenderingContext2D, width: number, height: number) {
  const pix = g.getImageData(0, 0, width, height);
  const d = pix.data;
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const y = lumaAt(d, i);
    d[i] = d[i + 1] = d[i + 2] = y;
    if (y < min) min = y; if (y > max) max = y;
  }
  const span = Math.max(1, max - min);
  for (let i = 0; i < d.length; i += 4) {
    const y = Math.max(0, Math.min(255, ((d[i] - min) / span) * 255));
    const c2 = y < 128 ? y * 0.85 : 255 - (255 - y) * 0.85;
    d[i] = d[i + 1] = d[i + 2] = c2;
  }
  g.putImageData(pix, 0, 0);
}

function brightBBox(pix: ImageData, w: number, h: number) {
  const d = pix.data;
  let x0 = w, y0 = h, x1 = 0, y1 = 0, hits = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (lumaAt(d, (y * w + x) * 4) < 165) continue;
      hits++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (hits < w * h * 0.04 || x1 - x0 < w * 0.25 || y1 - y0 < h * 0.25) {
    return { x: 0, y: 0, w, h };
  }
  const padX = Math.max(4, Math.round((x1 - x0) * 0.02));
  const padY = Math.max(4, Math.round((y1 - y0) * 0.02));
  x0 = Math.max(0, x0 - padX); y0 = Math.max(0, y0 - padY);
  x1 = Math.min(w - 1, x1 + padX); y1 = Math.min(h - 1, y1 + padY);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Dark vertical gutter between two side-by-side receipts, if both sides look like paper. */
function splitX(pix: ImageData, box: { x: number; y: number; w: number; h: number }): number | null {
  if (box.w < 200 || box.w / box.h < 0.85) return null;
  const { data, width } = pix;
  const col = new Float32Array(box.w);
  const step = Math.max(1, Math.floor(box.h / 120));
  for (let i = 0; i < box.w; i++) {
    let s = 0, n = 0;
    const x = box.x + i;
    for (let y = box.y; y < box.y + box.h; y += step) {
      s += lumaAt(data, (y * width + x) * 4);
      n++;
    }
    col[i] = s / n;
  }
  const mid0 = Math.round(box.w * 0.28);
  const mid1 = Math.round(box.w * 0.72);
  let best = -1, bestVal = 255;
  const win = Math.max(3, Math.round(box.w * 0.02));
  for (let i = mid0; i < mid1; i++) {
    let s = 0;
    for (let k = -win; k <= win; k++) s += col[i + k] ?? col[i];
    const v = s / (win * 2 + 1);
    if (v < bestVal) { bestVal = v; best = i; }
  }
  const left = average(col, 0, best - win);
  const right = average(col, best + win, box.w);
  // Gutter must be clearly darker than both receipt sides, and both sides reasonably bright.
  if (best < 0 || bestVal > 110 || left < 140 || right < 140) return null;
  if (bestVal > left * 0.72 || bestVal > right * 0.72) return null;
  if (best < box.w * 0.28 || best > box.w * 0.72) return null;
  return box.x + best;
}

function average(col: Float32Array, a: number, b: number) {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(col.length, Math.max(a, b));
  if (hi <= lo) return 0;
  let s = 0;
  for (let i = lo; i < hi; i++) s += col[i];
  return s / (hi - lo);
}

/** Crop to the receipt paper, optionally split two side-by-side receipts, then contrast-stretch and upscale. */
export async function preprocessReceiptPhoto(img: Blob): Promise<Blob[]> {
  const bmp = await loadBitmap(img);
  const { w, h } = sizeOf(bmp);
  const probe = document.createElement('canvas');
  probe.width = w; probe.height = h;
  const pg = probe.getContext('2d')!;
  pg.drawImage(bmp as CanvasImageSource, 0, 0);
  const pix = pg.getImageData(0, 0, w, h);
  const box = brightBBox(pix, w, h);
  const cut = splitX(pix, box);
  const regions = cut == null
    ? [box]
    : [
        { x: box.x, y: box.y, w: cut - box.x, h: box.h },
        { x: cut, y: box.y, w: box.x + box.w - cut, h: box.h },
      ].filter(r => r.w >= 80 && r.h >= 80);
  const out: Blob[] = [];
  for (const r of regions) {
    const scale = Math.min(4, Math.max(1, 1800 / Math.max(r.w, r.h)));
    const c = document.createElement('canvas');
    c.width = Math.round(r.w * scale); c.height = Math.round(r.h * scale);
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = true;
    g.drawImage(bmp as CanvasImageSource, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
    contrastStretch(g, c.width, c.height);
    out.push(await toBlob(c));
  }
  return out.length ? out : [await preprocessExpiryPhoto(img, false)];
}

type TessWorker = { recognize: (img: Blob, opts?: object) => Promise<{ data: { text: string; lines?: { text: string }[] } }>; setParameters: (p: object) => Promise<void> };
let workerP: Promise<TessWorker> | null = null;

async function worker(): Promise<TessWorker> {
  if (!workerP) {
    workerP = (async () => {
      const { createWorker } = await import('tesseract.js');
      const w = await createWorker('eng', 1, {
        workerPath: asset('worker.min.js'),
        corePath: asset('core'),
        langPath: asset('lang'),
        gzip: true,
        workerBlobURL: true,
      });
      await w.setParameters({ tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz/.-: $@%*,()#&+' });
      return w as unknown as TessWorker;
    })();
    workerP.catch(() => { workerP = null; });
  }
  return workerP;
}

async function recognize(blob: Blob): Promise<string> {
  const r = await (await worker()).recognize(blob);
  return (r.data.text ?? '').replace(/\s+/g, ' ').trim();
}

/** Keep line breaks — the receipt parser is line-oriented. */
function textFromTess(data: { text: string; lines?: { text: string }[] }): string {
  const fromLines = (data.lines ?? []).map(l => (l.text ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (fromLines.length) return fromLines.join('\n');
  return (data.text ?? '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

async function recognizeReceipt(blob: Blob): Promise<string> {
  const r = await (await worker()).recognize(blob);
  return textFromTess(r.data);
}

export interface OcrExpiry { text: string; iso: string | null; monthOnly: boolean; raw: string }

/** Preprocess and read the photo. If the full frame has no date, try the centre crop (camera guide box). */
export async function ocrExpiry(img: Blob): Promise<OcrExpiry> {
  const empty = (text: string): OcrExpiry => ({ text, iso: null, monthOnly: false, raw: text });
  const tryOne = async (blob: Blob) => {
    const text = await recognize(blob);
    const p = parseExpiry(text);
    return p ? { text, iso: p.iso, monthOnly: p.monthOnly, raw: p.raw } : empty(text);
  };
  const full = await preprocessExpiryPhoto(img, false);
  const a = await tryOne(full);
  if (a.iso) return a;
  const crop = await preprocessExpiryPhoto(img, true);
  const b = await tryOne(crop);
  if (b.iso) return b;
  return { text: [a.text, b.text].filter(Boolean).join(' '), iso: null, monthOnly: false, raw: a.text || b.text };
}

/** Full-frame OCR for a receipt photo (no date-box crop). Splits side-by-side receipts. */
export async function ocrReceiptRegions(img: Blob): Promise<string[]> {
  const pres = await preprocessReceiptPhoto(img);
  const out: string[] = [];
  for (const pre of pres) out.push(await recognizeReceipt(pre));
  return out;
}

/** OCR a receipt photo; multiple regions are joined with a blank line. */
export async function ocrReceiptPhoto(img: Blob): Promise<string> {
  return (await ocrReceiptRegions(img)).join('\n\n');
}

/** OCR each receipt part, in order. A photo of two receipts contributes two texts. */
export async function ocrReceiptPhotos(imgs: Blob[]): Promise<string[]> {
  const out: string[] = [];
  for (const img of imgs) out.push(...await ocrReceiptRegions(img));
  return out;
}
