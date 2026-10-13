import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { partfolkHosting } from './src/server/local-hosting';
import { localReadAccessKey } from './src/server/local-access-key';

export default defineConfig(({ command }) => {
  const accessKey = command === 'serve' ? localReadAccessKey(resolve('.')) : undefined;
  return {
  base: '/', appType: 'mpa',
  plugins: [react(), partfolkHosting({ deskOnly: true, accessKey: () => accessKey })],
  define: { 'import.meta.env.VITE_ARKIV_READ_TRANSPORT': JSON.stringify(command === 'build' || !accessKey ? 'direct' : 'hosted') },
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  preview: { host: '127.0.0.1', port: 4174, strictPort: true },
  build: { target: 'es2022', outDir: 'dist-desk', sourcemap: false,
    rolldownOptions: { input: { desk: resolve(import.meta.dirname, 'desk.html'), error: resolve(import.meta.dirname, '404.html') } },
  },
  };
});
