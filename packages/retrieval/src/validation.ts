import { compareCodePointStrings } from './constants.js';
import { sha256Text } from './hash.js';
import {
  knowledgeCorpusRecordV1Schema,
  retrievalIndexV1Schema,
  type KnowledgeCorpusRecordV1,
  type RetrievalIndexV1,
} from './schemas.js';
import { tokenizeRetrievalTextV1 } from './tokenizer.js';

const assertStrictlySortedUnique = <T>(
  values: readonly T[],
  selector: (value: T) => string,
  label: string,
): void => {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareCodePointStrings(selector(previous), selector(current)) >= 0
    ) {
      throw new Error(`${label} must be strictly sorted and unique.`);
    }
  }
};

export const validateCorpusRecordsV1 = (
  input: readonly unknown[],
): readonly KnowledgeCorpusRecordV1[] => {
  const records = input.map((record) => knowledgeCorpusRecordV1Schema.parse(record));
  assertStrictlySortedUnique(records, (record) => record.documentId, 'Corpus records');
  const contentHashes = new Set<string>();
  for (const record of records) {
    const expectedHash = sha256Text(`${record.title}\n${record.normalizedText}`);
    if (record.contentSha256 !== expectedHash) throw new Error('Corpus content hash mismatch.');
    if (record.documentId !== `news_${expectedHash.slice(0, 24)}`) {
      throw new Error('Corpus document ID does not match its content hash.');
    }
    if (contentHashes.has(record.contentSha256)) throw new Error('Duplicate corpus content hash.');
    contentHashes.add(record.contentSha256);
  }
  return records;
};

export const validateIndexAgainstCorpusV1 = (
  input: unknown,
  records: readonly KnowledgeCorpusRecordV1[],
  corpusSha256: string,
): RetrievalIndexV1 => {
  const index = retrievalIndexV1Schema.parse(input);
  if (index.corpusSha256 !== corpusSha256) throw new Error('Index corpus hash mismatch.');
  if (index.documentCount !== records.length || index.documents.length !== records.length) {
    throw new Error('Index document count mismatch.');
  }
  assertStrictlySortedUnique(index.documents, (document) => document.documentId, 'Index documents');
  assertStrictlySortedUnique(index.terms, (term) => term.term, 'Index terms');

  const recordIds = new Set(records.map((record) => record.documentId));
  const indexedIds = new Set(index.documents.map((document) => document.documentId));
  if (recordIds.size !== indexedIds.size || [...recordIds].some((id) => !indexedIds.has(id))) {
    throw new Error('Index and corpus document sets differ.');
  }

  const postingTotals = new Map<string, number>();
  for (const term of index.terms) {
    assertStrictlySortedUnique(term.postings, (posting) => posting.documentId, 'Term postings');
    if (term.documentFrequency !== term.postings.length) {
      throw new Error('Term document frequency mismatch.');
    }
    for (const posting of term.postings) {
      if (!recordIds.has(posting.documentId))
        throw new Error('Posting references unknown document.');
      postingTotals.set(
        posting.documentId,
        (postingTotals.get(posting.documentId) ?? 0) + posting.termFrequency,
      );
    }
  }

  let totalLength = 0;
  for (const document of index.documents) {
    const record = records.find((candidate) => candidate.documentId === document.documentId);
    if (record === undefined) throw new Error('Index document is missing from corpus.');
    const actualLength = tokenizeRetrievalTextV1(record.normalizedText).length;
    if (
      document.length !== actualLength ||
      postingTotals.get(document.documentId) !== actualLength
    ) {
      throw new Error('Index document length mismatch.');
    }
    totalLength += actualLength;
  }
  const expectedAverage = records.length === 0 ? 0 : totalLength / records.length;
  if (index.averageDocumentLength !== expectedAverage) {
    throw new Error('Index average document length mismatch.');
  }
  return index;
};
