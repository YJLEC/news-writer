import { buildKnowledgeBundleV1 } from './build.js';
import { canonicalJson } from './canonical.js';
import { compareCodePointStrings } from './constants.js';
import { sha256Text } from './hash.js';
import {
  approvedKnowledgeSourceV1Schema,
  knowledgeSourceManifestV1Schema,
  type KnowledgeBundleBytes,
} from './schemas.js';
import {
  approvedKnowledgeCandidateDocumentV1Schema,
  type KnowledgeCandidateDocumentV1,
} from './source.js';
import type { KnowledgeMetadataBuildInput } from './bundle.js';

type FormalMetadataInput = Omit<
  KnowledgeMetadataBuildInput,
  | 'sourceScope'
  | 'sourceSetSha256'
  | 'approvedSourceCount'
  | 'rejectedSourceCount'
  | 'totalCharacters'
  | 'totalTokens'
>;

export type ApprovedKnowledgeScope = 'approved-built-in-college-news' | 'approved-private-profile';

export const buildApprovedKnowledgeBundleV1 = (input: {
  manifest: unknown;
  candidates: readonly KnowledgeCandidateDocumentV1[];
  trainingRules: string;
  metadata: FormalMetadataInput;
  sourceScope?: ApprovedKnowledgeScope;
}): KnowledgeBundleBytes => {
  const manifest = knowledgeSourceManifestV1Schema.parse(input.manifest);
  const sources = manifest.sources.map((source) => approvedKnowledgeSourceV1Schema.parse(source));
  if (sources.length === 0) throw new Error('Formal knowledge bundle requires approved sources.');

  const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
  const candidates = input.candidates.map((candidate) =>
    approvedKnowledgeCandidateDocumentV1Schema.parse(candidate),
  );
  if (candidates.length !== sources.length)
    throw new Error('Approved source/candidate count mismatch.');
  const candidateIds = new Set<string>();
  for (const candidate of candidates) {
    const source = sourceById.get(candidate.sourceId);
    if (source === undefined || source.sourceSha256 !== candidate.sourceSha256) {
      throw new Error('Approved candidate does not match its source manifest.');
    }
    if (candidateIds.has(candidate.sourceId))
      throw new Error('Duplicate approved candidate source ID.');
    candidateIds.add(candidate.sourceId);
  }

  const sourceSetSha256 = sha256Text(
    canonicalJson(
      sources
        .map((source) => ({
          sourceId: source.sourceId,
          sourceSha256: source.sourceSha256,
          projectPurposeAuthorizationId: source.projectPurposeAuthorizationId,
          redistributionScope: source.redistributionScope,
          redistributionReviewId: source.redistributionReviewId,
          privacyReviewId: source.privacyReviewId,
        }))
        .sort((left, right) => compareCodePointStrings(left.sourceId, right.sourceId)),
    ),
  );
  return buildKnowledgeBundleV1({
    documents: candidates.map((candidate) => ({
      title: candidate.title,
      text: candidate.normalizedRedactedText,
    })),
    trainingRules: input.trainingRules,
    metadata: {
      ...input.metadata,
      sourceScope: input.sourceScope ?? 'approved-built-in-college-news',
      sourceSetSha256,
      approvedSourceCount: sources.length,
      rejectedSourceCount: 0,
      totalCharacters: 0,
      totalTokens: 0,
    },
  });
};
