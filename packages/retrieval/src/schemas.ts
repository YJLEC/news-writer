import { sha256Schema, timestampSchema } from '@news-writer/shared';
import { z } from 'zod';

import {
  BM25_PARAMETERS,
  NORMALIZER_VERSION,
  RETRIEVAL_ENGINE_VERSION,
  TOKENIZER_VERSION,
} from './constants.js';

const safeCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).finite();
const positiveSafeCountSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).finite();
const nonEmptyTextSchema = (maximum: number) => z.string().trim().min(1).max(maximum);

export const knowledgeDocumentIdSchema = z.string().regex(/^news_[0-9a-f]{24}$/);

export const knowledgeCorpusRecordV1Schema = z
  .object({
    format: z.literal('news-writer-knowledge-document'),
    schemaVersion: z.literal(1),
    documentId: knowledgeDocumentIdSchema,
    title: nonEmptyTextSchema(500),
    eventLabel: nonEmptyTextSchema(500).optional(),
    semester: nonEmptyTextSchema(100).optional(),
    normalizedText: nonEmptyTextSchema(200_000),
    contentSha256: sha256Schema,
  })
  .strict();

export type KnowledgeCorpusRecordV1 = z.infer<typeof knowledgeCorpusRecordV1Schema>;

const postingSchema = z
  .object({
    documentId: knowledgeDocumentIdSchema,
    termFrequency: positiveSafeCountSchema,
  })
  .strict();

const indexTermSchema = z
  .object({
    term: nonEmptyTextSchema(100),
    documentFrequency: positiveSafeCountSchema,
    postings: z.array(postingSchema).min(1),
  })
  .strict();

export const retrievalIndexV1Schema = z
  .object({
    format: z.literal('news-writer-retrieval-index'),
    schemaVersion: z.literal(1),
    engineVersion: z.literal(RETRIEVAL_ENGINE_VERSION),
    normalizerVersion: z.literal(NORMALIZER_VERSION),
    tokenizerVersion: z.literal(TOKENIZER_VERSION),
    corpusSha256: sha256Schema,
    documentCount: safeCountSchema,
    averageDocumentLength: z.number().nonnegative().finite(),
    parameters: z
      .object({
        k1: z.literal(BM25_PARAMETERS.k1),
        b: z.literal(BM25_PARAMETERS.b),
        queryTfCap: z.literal(BM25_PARAMETERS.queryTfCap),
        defaultTopK: z.literal(BM25_PARAMETERS.defaultTopK),
        maximumTopK: z.literal(BM25_PARAMETERS.maximumTopK),
        reportScoreDecimals: z.literal(BM25_PARAMETERS.reportScoreDecimals),
      })
      .strict(),
    documents: z.array(
      z.object({ documentId: knowledgeDocumentIdSchema, length: positiveSafeCountSchema }).strict(),
    ),
    terms: z.array(indexTermSchema),
  })
  .strict();

export type RetrievalIndexV1 = z.infer<typeof retrievalIndexV1Schema>;

const artifactMetadataSchema = z
  .object({ sha256: sha256Schema, byteLength: safeCountSchema })
  .strict();

export const knowledgeMetadataV1Schema = z
  .object({
    format: z.literal('news-writer-knowledge-metadata'),
    schemaVersion: z.literal(1),
    knowledgeVersion: z.string().regex(/^kw_[0-9a-f]{16}_[0-9a-f]{16}$/),
    builtAt: timestampSchema,
    sourceScope: z.enum([
      'approved-built-in-college-news',
      'approved-private-profile',
      'synthetic-public-fixture',
    ]),
    sourceSetSha256: sha256Schema,
    authorizationBatchId: nonEmptyTextSchema(128),
    privacyReviewBatchId: nonEmptyTextSchema(128),
    contentReviewStatus: z.literal('approved'),
    privacyReviewStatus: z.literal('approved'),
    documentCount: safeCountSchema,
    builder: z
      .object({
        version: nonEmptyTextSchema(64),
        sourceSha256: sha256Schema,
        nodeVersion: nonEmptyTextSchema(64),
        icuVersion: nonEmptyTextSchema(64),
        unicodeVersion: nonEmptyTextSchema(64),
        extractorVersions: z.record(z.string().min(1).max(100), z.string().min(1).max(64)),
        normalizationVersion: z.literal(NORMALIZER_VERSION),
        redactionRulesVersion: nonEmptyTextSchema(64),
      })
      .strict(),
    retrieval: z
      .object({
        engineVersion: z.literal(RETRIEVAL_ENGINE_VERSION),
        tokenizerVersion: z.literal(TOKENIZER_VERSION),
        bm25: z
          .object({
            k1: z.literal(BM25_PARAMETERS.k1),
            b: z.literal(BM25_PARAMETERS.b),
            queryTermFrequencyCap: z.literal(BM25_PARAMETERS.queryTfCap),
          })
          .strict(),
      })
      .strict(),
    statistics: z
      .object({
        approvedSourceCount: safeCountSchema,
        emittedDocumentCount: safeCountSchema,
        rejectedSourceCount: safeCountSchema,
        duplicateCount: safeCountSchema,
        redactionCountsByCategory: z.record(z.string().min(1).max(100), safeCountSchema),
        totalCharacters: safeCountSchema,
        totalTokens: safeCountSchema,
      })
      .strict(),
    artifacts: z
      .object({
        corpus: artifactMetadataSchema,
        index: artifactMetadataSchema,
        trainingRules: artifactMetadataSchema,
      })
      .strict(),
    bundleContentSha256: sha256Schema,
  })
  .strict();

export type KnowledgeMetadataV1 = z.infer<typeof knowledgeMetadataV1Schema>;

export const approvedKnowledgeSourceV1Schema = z
  .object({
    sourceId: z.string().regex(/^src_[0-9a-f]{16}$/),
    relativePath: z
      .string()
      .min(1)
      .max(1_000)
      .refine((value) => !value.includes('\\') && !value.startsWith('/') && !value.includes(':'))
      .refine((value) =>
        value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
      ),
    sourceSha256: sha256Schema,
    format: z.enum(['docx', 'pdf', 'utf8-text']),
    projectPurposeAuthorizationId: nonEmptyTextSchema(128),
    redistributionScope: z.literal('internal-app'),
    redistributionReviewId: nonEmptyTextSchema(128),
    authorizationStatus: z.literal('approved'),
    privacyReviewId: nonEmptyTextSchema(128),
    privacyReviewStatus: z.literal('approved'),
  })
  .strict();

export type ApprovedKnowledgeSourceV1 = z.infer<typeof approvedKnowledgeSourceV1Schema>;

export const candidateKnowledgeSourceV1Schema = approvedKnowledgeSourceV1Schema
  .extend({
    redistributionReviewId: z.string().trim().max(128),
    privacyReviewId: z.string().trim().max(128),
    privacyReviewStatus: z.enum(['pending', 'approved', 'rejected']),
  })
  .strict();

export type CandidateKnowledgeSourceV1 = z.infer<typeof candidateKnowledgeSourceV1Schema>;

export const knowledgeSourceManifestV1Schema = z
  .object({
    format: z.literal('news-writer-knowledge-source-manifest'),
    schemaVersion: z.literal(1),
    sourceRootSha256: sha256Schema,
    sources: z.array(candidateKnowledgeSourceV1Schema).max(10_000),
  })
  .strict();

export type KnowledgeSourceManifestV1 = z.infer<typeof knowledgeSourceManifestV1Schema>;

export interface KnowledgeBundleBytes {
  corpus: Uint8Array;
  index: Uint8Array;
  trainingRules: Uint8Array;
  metadata: Uint8Array;
}

export interface ValidatedKnowledgeBundleV1 {
  records: readonly KnowledgeCorpusRecordV1[];
  index: RetrievalIndexV1;
  trainingRules: string;
  metadata: KnowledgeMetadataV1;
}
