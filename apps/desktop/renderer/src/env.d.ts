/// <reference types="vite/client" />

import type { NewsWriterApiV1 } from '@news-writer/shared/ipc';

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker(moduleId: string, label: string): Worker;
    };
    readonly newsWriter: NewsWriterApiV1;
  }
}

export {};
