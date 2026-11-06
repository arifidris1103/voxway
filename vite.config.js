import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: {
        sim: resolve(import.meta.dirname, 'index.html'),
        garage: resolve(import.meta.dirname, 'garage.html'),
      },
    },
  },
  server: { port: 5173 },
});
