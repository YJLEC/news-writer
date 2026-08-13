import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const desktopRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  main: {
    ssr: { noExternal: true },
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: {
          index: fileURLToPath(new URL('./main/index.ts', import.meta.url)),
          'ai-worker': fileURLToPath(
            new URL('../../packages/ai/src/worker-entry.ts', import.meta.url),
          ),
          'document-worker': fileURLToPath(
            new URL('../../packages/documents/src/document-worker.ts', import.meta.url),
          ),
        },
        output: { entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    ssr: { noExternal: true },
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: fileURLToPath(new URL('./preload/index.ts', import.meta.url)),
        output: {
          entryFileNames: 'index.cjs',
          format: 'cjs',
        },
      },
    },
  },
  renderer: {
    root: fileURLToPath(new URL('./renderer', import.meta.url)),
    resolve: {
      alias: {
        '@renderer': fileURLToPath(new URL('./renderer/src', import.meta.url)),
      },
    },
    plugins: [react()],
    build: {
      outDir: fileURLToPath(new URL('./out/renderer', import.meta.url)),
      emptyOutDir: true,
      rollupOptions: {
        input: fileURLToPath(new URL('./renderer/index.html', import.meta.url)),
      },
    },
    server: {
      fs: {
        strict: true,
        allow: [desktopRoot],
      },
    },
  },
});
