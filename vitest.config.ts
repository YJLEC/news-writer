import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          environment: 'node',
          include: ['packages/**/src/**/*.test.ts', 'apps/desktop/main/**/*.test.ts'],
          name: 'unit',
        },
      },
      {
        plugins: [react()],
        test: {
          environment: 'happy-dom',
          include: ['apps/desktop/renderer/src/**/*.test.tsx'],
          name: 'component',
        },
      },
    ],
  },
});
