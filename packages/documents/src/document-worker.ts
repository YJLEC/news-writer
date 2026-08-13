import { parentPort } from 'node:worker_threads';

import { buildNewsDocx } from './document.js';
import { boundedDocumentWorkerRequestSchema } from './contracts.js';
import { auditNewsDocx } from './audit.js';

if (parentPort === null) throw new Error('Document worker requires a parent port');
parentPort.once('message', (raw: unknown) => {
  const parsed = boundedDocumentWorkerRequestSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid document worker request');
  void buildNewsDocx(parsed.data.document, parsed.data.style)
    .then(async (bytes) => {
      await auditNewsDocx(bytes, parsed.data.document, [], parsed.data.style);
      parentPort!.postMessage({ requestId: parsed.data.requestId, ok: true, bytes });
    })
    .catch(() =>
      parentPort!.postMessage({
        requestId: parsed.data.requestId,
        ok: false,
        code: 'DOCUMENT_GENERATION_FAILED',
      }),
    );
});
