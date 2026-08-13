import { BM25_PARAMETERS, compareCodePointStrings } from './constants.js';
import { retrievalIndexV1Schema, type RetrievalIndexV1 } from './schemas.js';
import { tokenizeRetrievalTextV1 } from './tokenizer.js';

export interface RetrievalHitV1 {
  documentId: string;
  rawScore: number;
  score: number;
}

export const buildRetrievalIndexV1 = (
  records: readonly { documentId: string; normalizedText: string }[],
  corpusSha256: string,
): RetrievalIndexV1 => {
  const documentIds = new Set<string>();
  const documentLengths = new Map<string, number>();
  const termPostings = new Map<string, Map<string, number>>();

  for (const record of records) {
    if (documentIds.has(record.documentId))
      throw new Error(`Duplicate document ID: ${record.documentId}`);
    documentIds.add(record.documentId);
    const tokens = tokenizeRetrievalTextV1(record.normalizedText);
    if (tokens.length === 0)
      throw new Error(`Document has no retrieval tokens: ${record.documentId}`);
    documentLengths.set(record.documentId, tokens.length);
    const frequencies = new Map<string, number>();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    for (const [term, frequency] of frequencies) {
      const postings = termPostings.get(term) ?? new Map<string, number>();
      postings.set(record.documentId, frequency);
      termPostings.set(term, postings);
    }
  }

  const documents = [...documentLengths]
    .map(([documentId, length]) => ({ documentId, length }))
    .sort((left, right) => compareCodePointStrings(left.documentId, right.documentId));
  const totalLength = documents.reduce((sum, document) => sum + document.length, 0);
  const terms = [...termPostings]
    .sort(([left], [right]) => compareCodePointStrings(left, right))
    .map(([term, frequencies]) => {
      const postings = [...frequencies]
        .map(([documentId, termFrequency]) => ({ documentId, termFrequency }))
        .sort((left, right) => compareCodePointStrings(left.documentId, right.documentId));
      return { term, documentFrequency: postings.length, postings };
    });

  return retrievalIndexV1Schema.parse({
    format: 'news-writer-retrieval-index',
    schemaVersion: 1,
    engineVersion: 'bm25-han-ngram-v1',
    normalizerVersion: 'retrieval-normalizer-nfkc-html-v1',
    tokenizerVersion: 'han-1-2-3gram-ascii-v1',
    corpusSha256,
    documentCount: documents.length,
    averageDocumentLength: documents.length === 0 ? 0 : totalLength / documents.length,
    parameters: BM25_PARAMETERS,
    documents,
    terms,
  });
};

export const searchRetrievalIndexV1 = (
  indexInput: RetrievalIndexV1,
  normalizedRedactedQuery: string,
  topK: number = BM25_PARAMETERS.defaultTopK,
): readonly RetrievalHitV1[] => {
  const index = retrievalIndexV1Schema.parse(indexInput);
  if (!Number.isInteger(topK) || topK < 0 || topK > BM25_PARAMETERS.maximumTopK) {
    throw new RangeError(`topK must be an integer from 0 to ${BM25_PARAMETERS.maximumTopK}.`);
  }
  if (topK === 0 || index.documentCount === 0) return [];

  const queryFrequencies = new Map<string, number>();
  for (const token of tokenizeRetrievalTextV1(normalizedRedactedQuery)) {
    queryFrequencies.set(token, (queryFrequencies.get(token) ?? 0) + 1);
  }
  if (queryFrequencies.size === 0) return [];

  const lengths = new Map(
    index.documents.map((document) => [document.documentId, document.length]),
  );
  const terms = new Map(index.terms.map((term) => [term.term, term]));
  const scores = new Map<string, number>();

  for (const [term, queryFrequency] of queryFrequencies) {
    const entry = terms.get(term);
    if (entry === undefined) continue;
    const idf = Math.log(
      1 + (index.documentCount - entry.documentFrequency + 0.5) / (entry.documentFrequency + 0.5),
    );
    for (const posting of entry.postings) {
      const length = lengths.get(posting.documentId);
      if (length === undefined) throw new Error('Index posting references an unknown document.');
      const denominator =
        posting.termFrequency +
        BM25_PARAMETERS.k1 *
          (1 - BM25_PARAMETERS.b + (BM25_PARAMETERS.b * length) / index.averageDocumentLength);
      const termScore =
        idf *
        ((posting.termFrequency * (BM25_PARAMETERS.k1 + 1)) / denominator) *
        Math.min(queryFrequency, BM25_PARAMETERS.queryTfCap);
      scores.set(posting.documentId, (scores.get(posting.documentId) ?? 0) + termScore);
    }
  }

  return [...scores]
    .filter(([, rawScore]) => Number.isFinite(rawScore) && rawScore > 0)
    .map(([documentId, rawScore]) => ({
      documentId,
      rawScore,
      score: Number(rawScore.toFixed(BM25_PARAMETERS.reportScoreDecimals)),
    }))
    .sort((left, right) =>
      left.rawScore === right.rawScore
        ? compareCodePointStrings(left.documentId, right.documentId)
        : right.rawScore - left.rawScore,
    )
    .slice(0, topK);
};
