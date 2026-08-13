import { canonicalJson } from './canonical.js';
import { buildCorpusV1, serializeCorpusJsonlV1, type KnowledgeDocumentInputV1 } from './corpus.js';
import {
  createKnowledgeMetadataV1,
  type KnowledgeMetadataBuildInput,
  validateKnowledgeBundleV1,
} from './bundle.js';
import { sha256Bytes } from './hash.js';
import { buildRetrievalIndexV1 } from './search.js';
import { tokenizeRetrievalTextV1 } from './tokenizer.js';
import type { KnowledgeBundleBytes } from './schemas.js';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

export const buildKnowledgeBundleV1 = (input: {
  documents: readonly KnowledgeDocumentInputV1[];
  trainingRules: string;
  metadata: KnowledgeMetadataBuildInput;
}): KnowledgeBundleBytes => {
  const records = buildCorpusV1(input.documents);
  const corpus = encode(serializeCorpusJsonlV1(records));
  const indexValue = buildRetrievalIndexV1(records, sha256Bytes(corpus));
  const index = encode(canonicalJson(indexValue));
  const rulesText = `${input.trainingRules.trim()}\n`;
  const trainingRules = encode(rulesText);
  const metadataValue = createKnowledgeMetadataV1(
    {
      ...input.metadata,
      totalCharacters: records.reduce(
        (sum, record) => sum + Array.from(record.normalizedText).length,
        0,
      ),
      totalTokens: records.reduce(
        (sum, record) => sum + tokenizeRetrievalTextV1(record.normalizedText).length,
        0,
      ),
    },
    { corpus, index, trainingRules },
    records.length,
  );
  const metadata = encode(canonicalJson(metadataValue));
  const bundle = { corpus, index, trainingRules, metadata };
  validateKnowledgeBundleV1(bundle);
  return bundle;
};
