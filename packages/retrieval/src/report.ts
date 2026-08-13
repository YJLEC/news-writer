import { retrievalReportSchema, type RetrievalReport } from '@news-writer/domain';
import {
  retrievalReportIdSchema,
  timestampSchema,
  type RetrievalReportId,
  type Timestamp,
} from '@news-writer/shared';

import { MAX_PROMPT_EXCERPT_CODE_POINTS, RETRIEVAL_ENGINE_VERSION } from './constants.js';
import { sha256Text } from './hash.js';
import { normalizeRetrievalTextV1 } from './normalization.js';
import { searchRetrievalIndexV1 } from './search.js';
import type { ValidatedKnowledgeBundleV1 } from './schemas.js';

export type RetrievalFactHints = RetrievalReport['factHints'];

export interface BuildRetrievalReportInputV1 {
  id: RetrievalReportId | string;
  createdAt: Timestamp | string;
  redactedText: string;
  factHints: RetrievalFactHints;
  topK?: number;
}

const promptExcerpt = (text: string): string => {
  const points = Array.from(text);
  if (points.length <= MAX_PROMPT_EXCERPT_CODE_POINTS) return text.trim();
  return `${points.slice(0, MAX_PROMPT_EXCERPT_CODE_POINTS).join('').trim()}……`;
};

export const buildRetrievalReportV1 = (
  bundle: ValidatedKnowledgeBundleV1,
  input: BuildRetrievalReportInputV1,
): RetrievalReport => {
  const redactedQueryText = normalizeRetrievalTextV1(input.redactedText);
  const records = new Map(bundle.records.map((record) => [record.documentId, record]));
  const hits = searchRetrievalIndexV1(bundle.index, redactedQueryText, input.topK).map(
    (hit, index) => {
      const record = records.get(hit.documentId);
      if (record === undefined) throw new Error('Validated bundle is missing a search hit record.');
      return {
        rank: index + 1,
        documentId: hit.documentId,
        title: record.title,
        score: hit.score,
        promptExcerpt: promptExcerpt(record.normalizedText),
      };
    },
  );
  return retrievalReportSchema.parse({
    id: retrievalReportIdSchema.parse(input.id),
    createdAt: timestampSchema.parse(input.createdAt),
    knowledgeVersion: bundle.metadata.knowledgeVersion,
    retrievalEngineVersion: RETRIEVAL_ENGINE_VERSION,
    redactedQueryText,
    querySha256: sha256Text(redactedQueryText),
    factHints: input.factHints,
    hits,
  });
};

export const formatPromptReferencesV1 = (reportInput: RetrievalReport): string => {
  const report = retrievalReportSchema.parse(reportInput);
  if (report.hits.length === 0) return '【历史参考稿】\n未检索到相似旧稿。';
  return [
    '【历史参考稿】',
    '以下内容仅用于参考结构、标题和文风，不是本次活动的事实来源。',
    ...report.hits.map((hit) => `\n[参考 ${hit.rank}] ${hit.title}\n${hit.promptExcerpt}`),
  ].join('\n');
};
