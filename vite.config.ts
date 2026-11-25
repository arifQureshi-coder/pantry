import { defineConfig, type Plugin } from 'vite';
import { execSync } from 'node:child_process';

function ocrAssets(): Plugin {
  const run = () => execSync('node scripts/copy-ocr-assets.mjs', { stdio: 'inherit' });
  return { name: 'ocr-assets', buildStart: run, configureServer: run };
}

// Relative base so the build works from any sub-path (e.g. username.github.io/pantry/)
export default defineConfig({ base: './', plugins: [ocrAssets()], build: { outDir: 'dist', target: 'es2020' } });
