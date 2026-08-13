import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const desktopRoot = fileURLToPath(new URL('.', import.meta.url));
const outRoot = fileURLToPath(new URL('./out-e2e', import.meta.url));

export default defineConfig({
  main: {
    ssr: { noExternal: true },
    build: {
      outDir: fileURLToPath(new URL('./out-e2e/main', import.meta.url)),
      externalizeDeps: false,
      rollupOptions: {
        input: { index: fileURLToPath(new URL('./main/e2e.ts', import.meta.url)) },
        output: { entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    ssr: { noExternal: true },
    build: {
      outDir: fileURLToPath(new URL('./out-e2e/preload', import.meta.url)),
      externalizeDeps: false,
      rollupOptions: {
        input: fileURLToPath(new URL('./preload/index.ts', import.meta.url)),
        output: { entryFileNames: 'index.cjs', format: 'cjs' },
      },
    },
  },
  renderer: {
    root: fileURLToPath(new URL('./renderer', import.meta.url)),
    resolve: {
      alias: { '@renderer': fileURLToPath(new URL('./renderer/src', import.meta.url)) },
    },
    plugins: [react()],
    build: {
      outDir: fileURLToPath(new URL('./out-e2e/renderer', import.meta.url)),
      emptyOutDir: true,
      rollupOptions: { input: fileURLToPath(new URL('./renderer/index.html', import.meta.url)) },
    },
    server: { fs: { strict: true, allow: [desktopRoot, outRoot] } },
  },
});
