import { canonicalJson } from './canonical.js';
import {
  BM25_PARAMETERS,
  NORMALIZER_VERSION,
  RETRIEVAL_ENGINE_VERSION,
  TOKENIZER_VERSION,
} from './constants.js';
import { sha256Bytes, sha256Text } from './hash.js';
import {
  knowledgeMetadataV1Schema,
  type KnowledgeBundleBytes,
  type KnowledgeMetadataV1,
  type ValidatedKnowledgeBundleV1,
} from './schemas.js';
import { validateCorpusRecordsV1, validateIndexAgainstCorpusV1 } from './validation.js';

const MAX_CORPUS_BYTES = 100 * 1024 * 1024;
const MAX_INDEX_BYTES = 200 * 1024 * 1024;
const MAX_RULES_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_CORPUS_RECORDS = 10_000;

const decodeUtf8 = (bytes: Uint8Array, maximum: number, label: string): string => {
  if (bytes.byteLength > maximum) throw new Error(`${label} exceeds the size limit.`);
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (value.includes('\0') || value.includes('\uFFFD'))
    throw new Error(`${label} contains invalid text.`);
  return value;
};

const parseJson = (text: string, label: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
};

export const validateKnowledgeBundleV1 = (
  bundle: KnowledgeBundleBytes,
): ValidatedKnowledgeBundleV1 => {
  const corpusText = decodeUtf8(bundle.corpus, MAX_CORPUS_BYTES, 'Corpus');
  if (corpusText.length > 0 && (!corpusText.endsWith('\n') || corpusText.endsWith('\n\n'))) {
    throw new Error('Corpus must use a single trailing LF.');
  }
  const lines = corpusText.length === 0 ? [] : corpusText.slice(0, -1).split('\n');
  if (lines.length > MAX_CORPUS_RECORDS) throw new Error('Corpus record limit exceeded.');
  const records = validateCorpusRecordsV1(
    lines.map((line, index) => parseJson(line, `Corpus line ${index + 1}`)),
  );
  const corpusSha256 = sha256Bytes(bundle.corpus);

  const indexText = decodeUtf8(bundle.index, MAX_INDEX_BYTES, 'Index');
  const index = validateIndexAgainstCorpusV1(parseJson(indexText, 'Index'), records, corpusSha256);

  const trainingRules = decodeUtf8(bundle.trainingRules, MAX_RULES_BYTES, 'Training rules');
  if (
    trainingRules.trim().length === 0 ||
    !trainingRules.endsWith('\n') ||
    trainingRules.endsWith('\n\n')
  ) {
    throw new Error('Training rules must be non-empty with a single trailing LF.');
  }
  const metadataText = decodeUtf8(bundle.metadata, MAX_METADATA_BYTES, 'Metadata');
  const metadata = knowledgeMetadataV1Schema.parse(parseJson(metadataText, 'Metadata'));

  if (
    metadata.documentCount !== records.length ||
    metadata.statistics.emittedDocumentCount !== records.length ||
    metadata.artifacts.corpus.sha256 !== corpusSha256 ||
    metadata.artifacts.corpus.byteLength !== bundle.corpus.byteLength ||
    metadata.artifacts.index.sha256 !== sha256Bytes(bundle.index) ||
    metadata.artifacts.index.byteLength !== bundle.index.byteLength ||
    metadata.artifacts.trainingRules.sha256 !== sha256Bytes(bundle.trainingRules) ||
    metadata.artifacts.trainingRules.byteLength !== bundle.trainingRules.byteLength
  ) {
    throw new Error('Knowledge metadata artifact mismatch.');
  }
  const expectedKnowledgeVersion = `kw_${corpusSha256.slice(0, 16)}_${sha256Bytes(bundle.index).slice(0, 16)}`;
  if (metadata.knowledgeVersion !== expectedKnowledgeVersion) {
    throw new Error('Knowledge version does not match its artifacts.');
  }
  const expectedBundleHash = sha256Text(
    canonicalJson({
      corpusSha256,
      indexSha256: sha256Bytes(bundle.index),
      trainingRulesSha256: sha256Bytes(bundle.trainingRules),
    }),
  );
  if (metadata.bundleContentSha256 !== expectedBundleHash) {
    throw new Error('Knowledge bundle content hash mismatch.');
  }
  return { records, index, trainingRules, metadata };
};

export interface KnowledgeMetadataBuildInput {
  builtAt: string;
  sourceScope:
    'approved-built-in-college-news' | 'approved-private-profile' | 'synthetic-public-fixture';
  sourceSetSha256: string;
  authorizationBatchId: string;
  privacyReviewBatchId: string;
  builderVersion: string;
  builderSourceSha256: string;
  nodeVersion: string;
  icuVersion: string;
  unicodeVersion: string;
  extractorVersions: Record<string, string>;
  redactionRulesVersion: string;
  approvedSourceCount: number;
  rejectedSourceCount: number;
  duplicateCount: number;
  redactionCountsByCategory: Record<string, number>;
  totalCharacters: number;
  totalTokens: number;
}

export const createKnowledgeMetadataV1 = (
  input: KnowledgeMetadataBuildInput,
  artifacts: Omit<KnowledgeBundleBytes, 'metadata'>,
  documentCount: number,
): KnowledgeMetadataV1 => {
  const corpusHash = sha256Bytes(artifacts.corpus);
  const indexHash = sha256Bytes(artifacts.index);
  const rulesHash = sha256Bytes(artifacts.trainingRules);
  return knowledgeMetadataV1Schema.parse({
    format: 'news-writer-knowledge-metadata',
    schemaVersion: 1,
    knowledgeVersion: `kw_${corpusHash.slice(0, 16)}_${indexHash.slice(0, 16)}`,
    builtAt: input.builtAt,
    sourceScope: input.sourceScope,
    sourceSetSha256: input.sourceSetSha256,
    authorizationBatchId: input.authorizationBatchId,
    privacyReviewBatchId: input.privacyReviewBatchId,
    contentReviewStatus: 'approved',
    privacyReviewStatus: 'approved',
    documentCount,
    builder: {
      version: input.builderVersion,
      sourceSha256: input.builderSourceSha256,
      nodeVersion: input.nodeVersion,
      icuVersion: input.icuVersion,
      unicodeVersion: input.unicodeVersion,
      extractorVersions: input.extractorVersions,
      normalizationVersion: NORMALIZER_VERSION,
      redactionRulesVersion: input.redactionRulesVersion,
    },
    retrieval: {
      engineVersion: RETRIEVAL_ENGINE_VERSION,
      tokenizerVersion: TOKENIZER_VERSION,
      bm25: {
        k1: BM25_PARAMETERS.k1,
        b: BM25_PARAMETERS.b,
        queryTermFrequencyCap: BM25_PARAMETERS.queryTfCap,
      },
    },
    statistics: {
      approvedSourceCount: input.approvedSourceCount,
      emittedDocumentCount: documentCount,
      rejectedSourceCount: input.rejectedSourceCount,
      duplicateCount: input.duplicateCount,
      redactionCountsByCategory: input.redactionCountsByCategory,
      totalCharacters: input.totalCharacters,
      totalTokens: input.totalTokens,
    },
    artifacts: {
      corpus: { sha256: corpusHash, byteLength: artifacts.corpus.byteLength },
      index: { sha256: indexHash, byteLength: artifacts.index.byteLength },
      trainingRules: { sha256: rulesHash, byteLength: artifacts.trainingRules.byteLength },
    },
    bundleContentSha256: sha256Text(
      canonicalJson({
        corpusSha256: corpusHash,
        indexSha256: indexHash,
        trainingRulesSha256: rulesHash,
      }),
    ),
  });
};
