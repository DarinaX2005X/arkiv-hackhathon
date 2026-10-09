import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  base: './', plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: { target: 'es2022', outDir: 'dist', sourcemap: true,
    rollupOptions: { input: { studio: resolve('index.html'), desk: resolve('desk.html') } },
  },
});
