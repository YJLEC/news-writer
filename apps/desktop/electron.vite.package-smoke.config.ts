import { fileURLToPath } from 'node:url';

import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    ssr: { noExternal: true },
    build: {
      outDir: fileURLToPath(new URL('./out-package-smoke/main', import.meta.url)),
      externalizeDeps: false,
      rollupOptions: {
        input: {
          index: fileURLToPath(new URL('./main/package-smoke.ts', import.meta.url)),
          'document-worker': fileURLToPath(
            new URL('../../packages/documents/src/document-worker.ts', import.meta.url),
          ),
        },
        output: { entryFileNames: '[name].js' },
      },
    },
  },
});
