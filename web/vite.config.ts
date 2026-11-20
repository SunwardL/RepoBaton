import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The server serves the build at "/", and the API is at "/api" on the same origin,
// so no proxy or CORS is needed in production. In dev, proxy /api to a running `repobaton ui`.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/api': { target: process.env.REPOBATON_URL ?? 'http://127.0.0.1:8787', changeOrigin: false } } },
});
