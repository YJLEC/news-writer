import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_MAX_INPUT_BYTES,
  isDocumentWorkerRequestWithinLimit,
  type NewsDocument,
} from './contracts.js';
import { NodeDocumentWorkerRunner } from './worker.js';

const document: NewsDocument = {
  title: '标题',
  bodyParagraphs: ['正文。'],
  signOff: '单位',
  dateText: '2026年8月10日',
  dateStamp: '20260810',
};
const helper = (mode: string) =>
  pathToFileURL(path.resolve(`tests/helpers/document-worker-${mode}.mjs`));

describe('document worker arbitration', () => {
  it('rejects clean exit before a response', async () => {
    await expect(
      new NodeDocumentWorkerRunner(helper('clean-exit'), 2_000).generate(document),
    ).rejects.toMatchObject({ code: 'DOCUMENT_GENERATION_FAILED' });
  });
  it('rejects invalid response and worker error', async () => {
    await expect(
      new NodeDocumentWorkerRunner(helper('invalid'), 2_000).generate(document),
    ).rejects.toMatchObject({ code: 'DOCUMENT_GENERATION_FAILED' });
    await expect(
      new NodeDocumentWorkerRunner(helper('error'), 2_000).generate(document),
    ).rejects.toMatchObject({ code: 'DOCUMENT_GENERATION_FAILED' });
  });
  it('settles an active run when shutdown races it', async () => {
    const runner = new NodeDocumentWorkerRunner(helper('hang'), 5_000);
    const pending = runner.generate(document);
    await runner.shutdown();
    await expect(pending).rejects.toMatchObject({ code: 'DOCUMENT_GENERATION_FAILED' });
  });
  it('counts canonical UTF-8 bytes at the 16 MiB boundary', () => {
    const prefix = '{"text":"';
    const suffix = '"}';
    const available =
      DOCUMENT_MAX_INPUT_BYTES - new TextEncoder().encode(prefix + suffix).byteLength;
    const within = { text: '中'.repeat(Math.floor(available / 3)) };
    expect(isDocumentWorkerRequestWithinLimit(within)).toBe(true);
    expect(isDocumentWorkerRequestWithinLimit({ text: `${within.text}中文` })).toBe(false);
  });
  it('rejects an oversized canonical request inside the real worker entry', async () => {
    const worker = new Worker(
      pathToFileURL(path.resolve('packages/documents/dist/document-worker.js')),
    );
    const request = {
      requestId: '10000000-0000-4000-8000-000000000001',
      document: {
        ...document,
        bodyParagraphs: Array.from({ length: 280 }, () => '中'.repeat(20_000)),
      },
    };
    expect(isDocumentWorkerRequestWithinLimit(request)).toBe(false);
    try {
      await expect(
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('worker did not reject request')), 5_000);
          worker.once('message', () => {
            clearTimeout(timer);
            reject(new Error('oversized request produced a response'));
          });
          worker.once('error', (error) => {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error('worker emitted a non-Error'));
          });
          worker.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`worker exited with code ${code}`));
          });
          worker.postMessage(request);
        }),
      ).rejects.toThrow(/Invalid document worker request|worker exited with code 1/u);
    } finally {
      await worker.terminate();
    }
  });
});
