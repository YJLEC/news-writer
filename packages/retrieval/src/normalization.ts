import { decodeHTML } from 'entities';

export const normalizeRetrievalTextV1 = (text: string): string => {
  const decoded = decodeHTML(text).normalize('NFKC');
  const withoutControls = decoded
    .replaceAll('\0', '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/gu, ' ')
    .replace(/\r\n?/gu, '\n');

  return withoutControls
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/gu, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
};
