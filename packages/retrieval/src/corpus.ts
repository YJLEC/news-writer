import { sha256Schema } from '@news-writer/shared';

import { canonicalJsonLine } from './canonical.js';
import { compareCodePointStrings } from './constants.js';
import { sha256Text } from './hash.js';
import { normalizeRetrievalTextV1 } from './normalization.js';
import { knowledgeCorpusRecordV1Schema, type KnowledgeCorpusRecordV1 } from './schemas.js';

export interface KnowledgeDocumentInputV1 {
  title: string;
  text: string;
  eventLabel?: string;
  semester?: string;
}

export const createKnowledgeCorpusRecordV1 = (
  input: KnowledgeDocumentInputV1,
): KnowledgeCorpusRecordV1 => {
  const title = normalizeRetrievalTextV1(input.title);
  const normalizedText = normalizeRetrievalTextV1(input.text);
  const contentSha256 = sha256Text(`${title}\n${normalizedText}`);
  const record = {
    format: 'news-writer-knowledge-document' as const,
    schemaVersion: 1 as const,
    documentId: `news_${contentSha256.slice(0, 24)}`,
    title,
    ...(input.eventLabel === undefined
      ? {}
      : { eventLabel: normalizeRetrievalTextV1(input.eventLabel) }),
    ...(input.semester === undefined ? {} : { semester: normalizeRetrievalTextV1(input.semester) }),
    normalizedText,
    contentSha256: sha256Schema.parse(contentSha256),
  };
  return knowledgeCorpusRecordV1Schema.parse(record);
};

export const buildCorpusV1 = (
  inputs: readonly KnowledgeDocumentInputV1[],
): readonly KnowledgeCorpusRecordV1[] => {
  const records = inputs.map(createKnowledgeCorpusRecordV1);
  const ids = new Set<string>();
  const hashes = new Set<string>();
  for (const record of records) {
    if (ids.has(record.documentId)) throw new Error(`Duplicate document ID: ${record.documentId}`);
    if (hashes.has(record.contentSha256)) throw new Error('Duplicate knowledge document content.');
    ids.add(record.documentId);
    hashes.add(record.contentSha256);
  }
  return records.sort((left, right) => compareCodePointStrings(left.documentId, right.documentId));
};

export const serializeCorpusJsonlV1 = (records: readonly KnowledgeCorpusRecordV1[]): string => {
  const parsed = records.map((record) => knowledgeCorpusRecordV1Schema.parse(record));
  const sorted = [...parsed].sort((left, right) =>
    compareCodePointStrings(left.documentId, right.documentId),
  );
  return sorted.length === 0 ? '' : `${sorted.map(canonicalJsonLine).join('\n')}\n`;
};
