import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

/** Full-screen camera overlay. Used for both barcode scanning and photo capture. */
function overlay(title: string, hint: string) {
  const el = document.createElement('div');
  el.className = 'cam';
  el.innerHTML = `
    <video playsinline muted autoplay></video>
    <div class="cam-frame"></div>
    <div class="cam-top"><button class="icon-btn cam-close" aria-label="Close">✕</button><span>${title}</span><span style="width:40px"></span></div>
    <div class="cam-bottom"><p class="cam-hint">${hint}</p><div class="cam-actions"></div></div>`;
  document.body.appendChild(el);
  return { el, video: el.querySelector('video') as HTMLVideoElement, actions: el.querySelector('.cam-actions') as HTMLElement, hintEl: el.querySelector('.cam-hint') as HTMLElement };
}

const constraints: MediaStreamConstraints = { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } };

/** Resolves with the barcode text, 'manual' if the user wants to type it in, or null if closed. */
export function scanBarcode(): Promise<string | 'manual' | null> {
  return new Promise(resolve => {
    const o = overlay('Scan barcode', 'Line the barcode up inside the box');
    o.el.querySelector('.cam-frame')!.classList.add('wide');
    o.actions.innerHTML = `<button class="btn ghost light" data-a="manual">Enter manually</button>`;
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_128, BarcodeFormat.QR_CODE]);
    const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 150 });
    let controls: IScannerControls | null = null; let done = false;
    const finish = (v: string | 'manual' | null) => {
      if (done) return; done = true;
      controls?.stop(); o.el.remove(); resolve(v);
    };
    o.el.querySelector('.cam-close')!.addEventListener('click', () => finish(null));
    o.actions.querySelector('[data-a=manual]')!.addEventListener('click', () => finish('manual'));
    reader.decodeFromConstraints(constraints, o.video, (res) => {
      if (res && !done) { navigator.vibrate?.(60); finish(res.getText()); }
    }).then(c => { controls = c; if (done) c.stop(); })
      .catch(err => { o.hintEl.textContent = cameraError(err); });
  });
}

/** Live camera with a shutter button. Falls back to the iOS photo picker if the camera can't start. */
export function capturePhoto(title: string, hint: string): Promise<Blob | null> {
  return new Promise(resolve => {
    const o = overlay(title, hint);
    o.actions.innerHTML = `<button class="shutter" aria-label="Take photo"></button><label class="btn ghost light">Photo library<input type="file" accept="image/*" hidden></label>`;
    let stream: MediaStream | null = null; let done = false;
    const finish = (b: Blob | null) => { if (done) return; done = true; stream?.getTracks().forEach(t => t.stop()); o.el.remove(); resolve(b); };
    o.el.querySelector('.cam-close')!.addEventListener('click', () => finish(null));
    o.actions.querySelector('input')!.addEventListener('change', e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) finish(f); });
    o.actions.querySelector('.shutter')!.addEventListener('click', () => {
      const v = o.video; if (!v.videoWidth) return;
      const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d')!.drawImage(v, 0, 0);
      c.toBlob(b => finish(b), 'image/jpeg', 0.92);
    });
    navigator.mediaDevices?.getUserMedia(constraints).then(s => {
      stream = s; if (done) return finish(null);
      o.video.srcObject = s; o.video.play().catch(() => {});
    }).catch(err => { o.hintEl.textContent = cameraError(err) + ' You can still pick a photo.'; });
  });
}

function cameraError(err: any) {
  if (err?.name === 'NotAllowedError') return 'Camera access was blocked. Allow it in Settings › Safari › Camera.';
  if (!window.isSecureContext) return 'The camera needs HTTPS.';
  return 'Could not start the camera.';
}

/** Offline OCR fallback when there is no AI key. Loads Tesseract on demand. */
export async function ocrText(img: Blob): Promise<string> {
  const { recognize } = await import('tesseract.js');
  const r = await recognize(img, 'eng');
  return r.data.text;
}
