import { NodeDocumentWorkerRunner, auditNewsDocx, type NewsDocument } from '@news-writer/documents';
import { app } from 'electron';

const runner = new NodeDocumentWorkerRunner();
const document: NewsDocument = {
  title: '便携包文档工作线程测试',
  bodyParagraphs: ['该内容仅在隔离的打包验收进程内生成。'],
  signOff: 'News Writer',
  dateText: '2026年8月11日',
  dateStamp: '20260811',
};

void runner
  .generate(document)
  .then(async (bytes) => {
    await auditNewsDocx(bytes, document);
    process.stdout.write(`NW_DOCUMENT_WORKER_SMOKE_OK ${bytes.byteLength}\n`);
    await runner.shutdown();
    app.exit(0);
  })
  .catch(async () => {
    await runner.shutdown();
    app.exit(1);
  });
