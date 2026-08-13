import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  auditNewsDocx,
  buildNewsDocx,
  parseNewsDocument,
} from '../packages/documents/dist/index.js';

const cases = [
  ['GD-SINGLE', 'single-page.md'],
  ['GD-MULTI', 'multi-page.md'],
  ['GD-LONG-TITLE', 'long-title.md'],
];
const output = path.resolve('tests/artifacts/stage7/docx');
await mkdir(output, { recursive: true });

for (const [id, source] of cases) {
  const document = parseNewsDocument(
    await readFile(path.resolve('tests/fixtures/documents/source', source), 'utf8'),
  );
  const bytes = await buildNewsDocx(document);
  await auditNewsDocx(bytes, document, ['PROMPT_SENTINEL', 'COMMENT_SENTINEL', 'API_KEY_SENTINEL']);
  await writeFile(path.join(output, `${id}.docx`), bytes);
  console.log(`${id}: ${bytes.byteLength} bytes`);
}
