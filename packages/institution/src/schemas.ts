import {
  knowledgeMetadataV1Schema,
  type KnowledgeBundleBytes,
  type ValidatedKnowledgeBundleV1,
} from '@news-writer/retrieval';
import { sha256Schema, timestampSchema } from '@news-writer/shared';
import { z } from 'zod';

import { INSTITUTION_PROFILE_SCOPES } from './constants.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).finite();
const profileId = z.string().regex(/^profile_[a-z0-9][a-z0-9-]{1,63}$/);
const version = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

export const institutionProfileScopeSchema = z.enum(INSTITUTION_PROFILE_SCOPES);
export type InstitutionProfileScope = z.infer<typeof institutionProfileScopeSchema>;

const artifactRefSchema = z.object({ sha256: sha256Schema, byteLength: safeCount }).strict();

const artifactManifestSchema = z
  .object({
    institution: artifactRefSchema,
    writingRules: artifactRefSchema,
    promptContract: artifactRefSchema,
    documentStyle: artifactRefSchema,
    knowledge: z
      .object({
        corpus: artifactRefSchema,
        index: artifactRefSchema,
        trainingRules: artifactRefSchema,
        metadata: artifactRefSchema,
      })
      .strict(),
    fontsManifest: artifactRefSchema,
  })
  .strict();

export const institutionManifestV1Schema = z
  .object({
    format: z.literal('news-writer-institution-manifest'),
    schemaVersion: z.literal(1),
    profileId,
    profileVersion: version,
    institutionName: text(200),
    writingRulesVersion: version,
    promptContractVersion: version,
    documentStyleVersion: version,
    knowledgeVersion: z.string().regex(/^kw_[0-9a-f]{16}_[0-9a-f]{16}$/),
    supportedAppVersion: text(64),
    builtAt: timestampSchema,
    sourceScope: institutionProfileScopeSchema,
    privacyReviewStatus: z.enum(['approved', 'pending', 'rejected']),
    contentReviewStatus: z.enum(['approved', 'pending', 'rejected']),
    fontRedistributionStatus: z.enum(['not-applicable', 'approved', 'restricted']),
    artifacts: artifactManifestSchema,
    bundleContentSha256: sha256Schema,
  })
  .strict();
export type InstitutionManifestV1 = z.infer<typeof institutionManifestV1Schema>;

export const institutionConfigV1Schema = z
  .object({
    format: z.literal('news-writer-institution-config'),
    schemaVersion: z.literal(1),
    displayName: text(200),
    defaultNewsType: z.enum(['college-news', 'other-news']),
    officialPublisher: text(200),
    permittedPublisherSources: z.array(text(300)).max(100),
    targetChannels: z.array(text(100)).max(100),
    dateDisplayRule: text(500),
    defaultWordCountRecommendation: z.number().int().positive().max(100_000),
    preferredTerms: z.array(text(100)).max(500),
    forbiddenTerms: z.array(text(100)).max(500),
    externalOrganizerRules: text(2_000),
  })
  .strict();
export type InstitutionConfigV1 = z.infer<typeof institutionConfigV1Schema>;

const writingRuleSchema = z
  .object({
    id: z.string().regex(/^rule_[a-z0-9][a-z0-9-]{1,63}$/),
    text: text(2_000),
    level: z.enum(['hard-constraint', 'style-guidance']),
    scenarios: z.array(text(200)).max(50),
  })
  .strict();

export const writingRulesV1Schema = z
  .object({
    format: z.literal('news-writer-writing-rules'),
    schemaVersion: z.literal(1),
    version,
    rules: z.array(writingRuleSchema).min(1).max(500),
  })
  .strict();
export type WritingRulesV1 = z.infer<typeof writingRulesV1Schema>;

export const promptContractV1Schema = z
  .object({
    format: z.literal('news-writer-prompt-contract'),
    schemaVersion: z.literal(1),
    version,
    sections: z
      .object({
        initialDraft: text(10_000),
        secondReview: text(10_000),
        commentRevision: text(10_000),
      })
      .strict(),
    organizationTerms: z.array(text(200)).max(500),
    forbiddenInstructions: z.array(text(500)).max(100),
  })
  .strict();
export type PromptContractV1 = z.infer<typeof promptContractV1Schema>;

const fontFaceSchema = z
  .object({
    family: text(200),
    fileName: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.(?:ttf|otf|ttc)$/i),
    version: text(100),
    sha256: sha256Schema,
    supplier: text(200),
    licenseName: text(200),
    redistributable: z.boolean(),
    requiresAdministratorInstall: z.boolean(),
    applicableStyles: z.array(text(100)).max(50),
  })
  .strict();

export const fontManifestV1Schema = z
  .object({
    format: z.literal('news-writer-font-manifest'),
    schemaVersion: z.literal(1),
    fonts: z.array(fontFaceSchema).max(100),
  })
  .strict();
export type FontManifestV1 = z.infer<typeof fontManifestV1Schema>;

export const documentStyleV1Schema = z
  .object({
    format: z.literal('news-writer-document-style'),
    schemaVersion: z.literal(1),
    version,
    page: z
      .object({
        width: text(20),
        height: text(20),
        margins: z
          .object({ top: text(20), right: text(20), bottom: text(20), left: text(20) })
          .strict(),
      })
      .strict(),
    title: z
      .object({
        fontFamily: text(200),
        fontSizePt: z.number().positive().max(200),
        alignment: z.enum(['left', 'center', 'right']),
        bold: z.boolean(),
        lineSpacing: z.number().positive().max(10),
      })
      .strict(),
    body: z
      .object({
        fontFamily: text(200),
        fontSizePt: z.number().positive().max(200),
        alignment: z.enum(['left', 'center', 'right', 'justify']),
        firstLineIndentPt: z.number().nonnegative().max(500),
        lineSpacing: z.number().positive().max(10),
        paragraphSpacingBeforePt: z.number().nonnegative().max(500),
        paragraphSpacingAfterPt: z.number().nonnegative().max(500),
      })
      .strict(),
    signoff: z
      .object({ alignment: z.enum(['left', 'center', 'right']), dateFormat: text(100) })
      .strict(),
    fileNameRule: text(500),
    fontFamilies: z.array(text(200)).max(100),
  })
  .strict();
export type DocumentStyleV1 = z.infer<typeof documentStyleV1Schema>;

export interface InstitutionBundleBytes {
  manifest: Uint8Array;
  institution: Uint8Array;
  writingRules: Uint8Array;
  promptContract: Uint8Array;
  documentStyle: Uint8Array;
  knowledge: KnowledgeBundleBytes;
  fontsManifest: Uint8Array;
  fonts: Readonly<Record<string, Uint8Array>>;
}

export interface ValidatedInstitutionBundleV1 {
  manifest: InstitutionManifestV1;
  institution: InstitutionConfigV1;
  writingRules: WritingRulesV1;
  promptContract: PromptContractV1;
  documentStyle: DocumentStyleV1;
  fontManifest: FontManifestV1;
  knowledge: ValidatedKnowledgeBundleV1;
  fonts: Readonly<Record<string, Uint8Array>>;
}

export { knowledgeMetadataV1Schema };
