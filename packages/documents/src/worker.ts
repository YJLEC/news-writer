import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

import {
  DOCUMENT_MAX_OUTPUT_BYTES,
  boundedDocumentWorkerRequestSchema,
  DocumentError,
  documentWorkerResponseSchema,
  newsDocumentSchema,
  type NewsDocument,
  type DocumentStyleTokens,
} from './contracts.js';

export interface DocumentWorkerRunner {
  generate(document: NewsDocument, style?: DocumentStyleTokens): Promise<Uint8Array>;
  shutdown(): Promise<void>;
}

export class NodeDocumentWorkerRunner implements DocumentWorkerRunner {
  readonly #entry: URL;
  readonly #workers = new Set<Worker>();
  readonly #timeoutMs: number;
  constructor(entry = new URL('./document-worker.js', import.meta.url), timeoutMs = 120_000) {
    this.#entry = entry;
    this.#timeoutMs = timeoutMs;
  }
  generate(raw: NewsDocument, style?: DocumentStyleTokens): Promise<Uint8Array> {
    const document = newsDocumentSchema.parse(raw);
    const requestId = randomUUID();
    const request = boundedDocumentWorkerRequestSchema.parse({
      requestId,
      document,
      ...(style === undefined ? {} : { style }),
    });
    const worker = new Worker(this.#entry);
    this.#workers.add(worker);
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(new DocumentError('DOCUMENT_GENERATION_FAILED', 'Document worker timed out')),
          ),
        this.#timeoutMs,
      );
      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#workers.delete(worker);
        void worker.terminate();
        operation();
      };
      worker.once('message', (rawResponse) => {
        const parsed = documentWorkerResponseSchema.safeParse(rawResponse);
        if (!parsed.success || parsed.data.requestId !== requestId || !parsed.data.ok)
          return finish(() =>
            reject(
              new DocumentError(
                'DOCUMENT_GENERATION_FAILED',
                'Document worker returned an invalid result',
              ),
            ),
          );
        const bytes = parsed.data.bytes;
        if (bytes.byteLength === 0 || bytes.byteLength > DOCUMENT_MAX_OUTPUT_BYTES)
          return finish(() =>
            reject(
              new DocumentError(
                'DOCUMENT_GENERATION_FAILED',
                'Document worker returned an invalid result',
              ),
            ),
          );
        finish(() => resolve(bytes));
      });
      worker.once('error', () =>
        finish(() =>
          reject(new DocumentError('DOCUMENT_GENERATION_FAILED', 'Document worker failed')),
        ),
      );
      worker.once('exit', () =>
        finish(() =>
          reject(
            new DocumentError('DOCUMENT_GENERATION_FAILED', 'Document worker exited unexpectedly'),
          ),
        ),
      );
      worker.postMessage(request);
    });
  }
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.#workers].map(async (worker) => {
        await worker.terminate();
      }),
    );
    this.#workers.clear();
  }
}
