import { defineConfig } from 'vite';
// Relative base so the build works from any sub-path (e.g. username.github.io/pantry/)
export default defineConfig({ base: './', build: { outDir: 'dist', target: 'es2020' } });
