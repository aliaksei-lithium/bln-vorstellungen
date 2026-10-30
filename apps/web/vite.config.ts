import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  // `pnpm dev` runs the Worker on :8787; the Vite dev server forwards API calls to it.
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
