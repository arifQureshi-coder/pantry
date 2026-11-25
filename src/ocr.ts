/**
 * On-device expiry OCR with Tesseract.js. Assets live under ./ocr/ and are
 * lazy-loaded on the first scan so startup stays fast; the service worker
 * then caches them for offline use.
 */
import { parseExpiry } from './dates';

const asset = (p: string) => new URL(`ocr/${p}`, document.baseURI).href;

/** Crop to the on-screen date box (10% sides, 32% from top, 22% tall), then greyscale, boost contrast and upscale. */
export async function preprocessExpiryPhoto(img: Blob, crop = true): Promise<Blob> {
  const bmp = await createImageBitmap(img).catch(async () => {
    const i = new Image();
    i.src = URL.createObjectURL(img);
    await i.decode();
    URL.revokeObjectURL(i.src);
    return i;
  });
  const w = 'naturalWidth' in bmp ? bmp.naturalWidth : bmp.width;
  const h = 'naturalHeight' in bmp ? bmp.naturalHeight : bmp.height;
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
  const pix = g.getImageData(0, 0, c.width, c.height);
  const d = pix.data;
  // Greyscale + contrast stretch around mid-grey.
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = y;
    if (y < min) min = y; if (y > max) max = y;
  }
  const span = Math.max(1, max - min);
  for (let i = 0; i < d.length; i += 4) {
    const y = Math.max(0, Math.min(255, ((d[i] - min) / span) * 255));
    // Extra contrast: pull midtones apart slightly.
    const c2 = y < 128 ? y * 0.85 : 255 - (255 - y) * 0.85;
    d[i] = d[i + 1] = d[i + 2] = c2;
  }
  g.putImageData(pix, 0, 0);
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('preprocess')), 'image/png'));
}

type TessWorker = { recognize: (img: Blob, opts?: object) => Promise<{ data: { text: string } }>; setParameters: (p: object) => Promise<void> };
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
      await w.setParameters({ tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz/.-: ' });
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
