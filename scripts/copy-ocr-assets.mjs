/** Copy Tesseract worker, LSTM cores and English traineddata into public/ocr for Vite to serve and the SW to cache. */
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'public', 'ocr');
const cores = [
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-relaxedsimd-lstm.wasm.js',
];

export async function copyOcrAssets() {
  mkdirSync(join(dest, 'core'), { recursive: true });
  mkdirSync(join(dest, 'lang'), { recursive: true });
  cpSync(join(root, 'node_modules/tesseract.js/dist/worker.min.js'), join(dest, 'worker.min.js'));
  for (const f of cores) {
    cpSync(join(root, 'node_modules/tesseract.js-core', f), join(dest, 'core', f));
  }
  const lang = join(dest, 'lang', 'eng.traineddata.gz');
  if (!existsSync(lang) || statSync(lang).size < 1000) {
    const urls = [
      'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
      'https://unpkg.com/@tesseract.js-data/eng@4.0.0_best_int/eng.traineddata.gz',
    ];
    let r, last = '';
    for (const url of urls) {
      r = await fetch(url);
      if (r.ok) break;
      last = `HTTP ${r.status} from ${url}`;
    }
    if (!r?.ok) throw new Error(`Failed to download eng.traineddata: ${last}`);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(lang, Buffer.from(await r.arrayBuffer()));
  }
  const sizes = [
    ['worker.min.js', join(dest, 'worker.min.js')],
    ...cores.map(f => [f, join(dest, 'core', f)]),
    ['eng.traineddata.gz', lang],
  ].map(([n, p]) => `${n} ${(statSync(p).size / 1048576).toFixed(2)} MB`);
  console.log('OCR assets ready:', sizes.join(', '));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await copyOcrAssets();
}
