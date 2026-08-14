import type { NewsDocument } from './contracts.js';
import { DocumentError, newsDocumentSchema } from './contracts.js';

const forbidden = /[<>:"/\\|?*\u0000-\u001F]/gu;
const existingDate = /^20\d{2}[年._-]?\d{1,2}[月._-]?\d{1,2}(?:日)?\s*/u;
const windowsReserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

export const suggestDocxFileName = (raw: NewsDocument): string => {
  const document = newsDocumentSchema.parse(raw);
  const clean = Array.from(
    document.title
      .replace(existingDate, '')
      .replace(forbidden, '_')
      .replace(/\s+/gu, ' ')
      .replace(/^[\s._]+|[\s._]+$/gu, ''),
  )
    .slice(0, 90)
    .join('')
    .replace(/[\s._]+$/gu, '');
  if (!clean)
    throw new DocumentError('DOCUMENT_CONTENT_INVALID', 'Document title cannot form a file name');
  const baseName = `${document.dateStamp === 'unknown' ? '' : document.dateStamp}${clean}`;
  const safeBase = windowsReserved.test(baseName) ? `_${baseName}` : baseName;
  const result = `${safeBase}.docx`;
  if (result.length > 255)
    throw new DocumentError('DOCUMENT_CONTENT_INVALID', 'Document file name is too long');
  return result;
};
