import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { partfolkHosting } from './src/server/local-hosting';
import { localReadAccessKey } from './src/server/local-access-key';

export default defineConfig(({ command }) => {
  const accessKey = command === 'serve' ? localReadAccessKey(resolve('.')) : undefined;
  return {
  base: '/', appType: 'mpa', plugins: [react(), partfolkHosting({ accessKey: () => accessKey })],
  define: { 'import.meta.env.VITE_ARKIV_READ_TRANSPORT': JSON.stringify(command === 'build' ? 'auto' : accessKey ? 'hosted' : 'direct') },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: { target: 'es2022', outDir: 'dist', sourcemap: false,
    rollupOptions: { input: { studio: resolve('index.html'), desk: resolve('desk.html'), error: resolve('404.html') } },
  },
  };
});
