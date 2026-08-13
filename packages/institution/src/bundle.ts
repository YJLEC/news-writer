import {
  canonicalJson,
  findForbiddenKnowledgeTextPatternsV1,
  validateKnowledgeBundleV1,
  type KnowledgeBundleBytes,
} from '@news-writer/retrieval';
import { INSTITUTION_RESOURCE_PATHS } from './constants.js';
import { sha256Bytes } from './hash.js';
import {
  documentStyleV1Schema,
  fontManifestV1Schema,
  institutionConfigV1Schema,
  institutionManifestV1Schema,
  promptContractV1Schema,
  type DocumentStyleV1,
  type FontManifestV1,
  type InstitutionBundleBytes,
  type InstitutionConfigV1,
  type InstitutionManifestV1,
  type InstitutionProfileScope,
  type PromptContractV1,
  type ValidatedInstitutionBundleV1,
  type WritingRulesV1,
  writingRulesV1Schema,
} from './schemas.js';

const decode = (bytes: Uint8Array, label: string): string => {
  if (bytes.byteLength > 2 * 1024 * 1024) throw new Error(`${label} exceeds the size limit.`);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
};

const parse = (bytes: Uint8Array, label: string): unknown => {
  try {
    return JSON.parse(decode(bytes, label)) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
};

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(canonicalJson(value));

const rejectSensitiveText = (value: unknown, key?: string): void => {
  if (typeof value === 'string') {
    if (key === 'sha256' || key === 'bundleContentSha256' || key === 'sourceSetSha256') return;
    const findings = findForbiddenKnowledgeTextPatternsV1(value);
    if (findings.length > 0)
      throw new Error(`Institution profile contains forbidden text: ${findings.join(',')}.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => rejectSensitiveText(entry));
    return;
  }
  if (value !== null && typeof value === 'object') {
    Object.entries(value).forEach(([entryKey, entry]) => rejectSensitiveText(entry, entryKey));
  }
};

const artifact = (bytes: Uint8Array) => ({
  sha256: sha256Bytes(bytes),
  byteLength: bytes.byteLength,
});

const manifestArtifacts = (bundle: Omit<InstitutionBundleBytes, 'manifest' | 'fonts'>) => ({
  institution: artifact(bundle.institution),
  writingRules: artifact(bundle.writingRules),
  promptContract: artifact(bundle.promptContract),
  documentStyle: artifact(bundle.documentStyle),
  knowledge: {
    corpus: artifact(bundle.knowledge.corpus),
    index: artifact(bundle.knowledge.index),
    trainingRules: artifact(bundle.knowledge.trainingRules),
    metadata: artifact(bundle.knowledge.metadata),
  },
  fontsManifest: artifact(bundle.fontsManifest),
});

const manifestHash = (manifest: Omit<InstitutionManifestV1, 'bundleContentSha256'>) =>
  sha256Bytes(new TextEncoder().encode(canonicalJson(manifest)));

export const validateInstitutionBundleV1 = (
  bundle: InstitutionBundleBytes,
): ValidatedInstitutionBundleV1 => {
  const manifest = institutionManifestV1Schema.parse(parse(bundle.manifest, 'Manifest'));
  const institution = institutionConfigV1Schema.parse(parse(bundle.institution, 'Institution'));
  const writingRules = writingRulesV1Schema.parse(parse(bundle.writingRules, 'Writing rules'));
  const promptContract = promptContractV1Schema.parse(
    parse(bundle.promptContract, 'Prompt contract'),
  );
  const documentStyle = documentStyleV1Schema.parse(parse(bundle.documentStyle, 'Document style'));
  const fontManifest = fontManifestV1Schema.parse(parse(bundle.fontsManifest, 'Font manifest'));
  rejectSensitiveText({ institution, writingRules, promptContract, documentStyle, fontManifest });
  const knowledge = validateKnowledgeBundleV1(bundle.knowledge);
  if (manifest.knowledgeVersion !== knowledge.metadata.knowledgeVersion)
    throw new Error('Institution manifest knowledge version mismatch.');
  if (manifest.institutionName !== institution.displayName)
    throw new Error('Institution manifest name mismatch.');
  if (
    manifest.writingRulesVersion !== writingRules.version ||
    manifest.promptContractVersion !== promptContract.version ||
    manifest.documentStyleVersion !== documentStyle.version
  )
    throw new Error('Institution profile version mismatch.');
  if (manifest.sourceScope === 'synthetic-public-fixture' && fontManifest.fonts.length > 0)
    throw new Error('Synthetic public profile cannot contain fonts.');
  if (manifest.fontRedistributionStatus === 'not-applicable' && fontManifest.fonts.length > 0)
    throw new Error('Font manifest status does not permit fonts.');
  if (fontManifest.fonts.some((font) => !font.redistributable))
    throw new Error('Institution profile contains a non-redistributable font.');
  const artifacts = manifestArtifacts(bundle);
  if (JSON.stringify(manifest.artifacts) !== JSON.stringify(artifacts))
    throw new Error('Institution resource hash or byte length mismatch.');
  const manifestWithoutHash = { ...manifest };
  delete (manifestWithoutHash as Partial<InstitutionManifestV1>).bundleContentSha256;
  const expectedHash = manifestHash(manifestWithoutHash);
  if (manifest.bundleContentSha256 !== expectedHash)
    throw new Error('Institution manifest content hash mismatch.');
  const expectedFonts = new Set(fontManifest.fonts.map((font) => font.fileName));
  const actualFonts = new Set(Object.keys(bundle.fonts));
  if (
    expectedFonts.size !== actualFonts.size ||
    [...expectedFonts].some((file) => !actualFonts.has(file))
  )
    throw new Error('Font manifest does not match bundled font files.');
  for (const font of fontManifest.fonts) {
    if (sha256Bytes(bundle.fonts[font.fileName]!) !== font.sha256)
      throw new Error('Font hash mismatch.');
  }
  return {
    manifest,
    institution,
    writingRules,
    promptContract,
    documentStyle,
    fontManifest,
    knowledge,
    fonts: bundle.fonts,
  };
};

export const buildInstitutionBundleV1 = (input: {
  scope: InstitutionProfileScope;
  profileId: string;
  profileVersion: string;
  supportedAppVersion: string;
  builtAt: string;
  institution: InstitutionConfigV1;
  writingRules: WritingRulesV1;
  promptContract: PromptContractV1;
  documentStyle: DocumentStyleV1;
  knowledge: KnowledgeBundleBytes;
  fonts?: Readonly<Record<string, Uint8Array>>;
  fontManifest?: FontManifestV1;
}): InstitutionBundleBytes => {
  const fonts = input.fonts ?? {};
  const fontManifest = input.fontManifest ?? {
    format: 'news-writer-font-manifest',
    schemaVersion: 1,
    fonts: [],
  };
  const institution = encode(institutionConfigV1Schema.parse(input.institution));
  const writingRules = encode(writingRulesV1Schema.parse(input.writingRules));
  const promptContract = encode(promptContractV1Schema.parse(input.promptContract));
  const documentStyle = encode(documentStyleV1Schema.parse(input.documentStyle));
  const fontsManifest = encode(fontManifestV1Schema.parse(fontManifest));
  const knowledge = input.knowledge;
  validateKnowledgeBundleV1(knowledge);
  const partial: Omit<InstitutionManifestV1, 'bundleContentSha256'> = institutionManifestV1Schema
    .omit({ bundleContentSha256: true })
    .parse({
      format: 'news-writer-institution-manifest' as const,
      schemaVersion: 1 as const,
      profileId: input.profileId,
      profileVersion: input.profileVersion,
      institutionName: input.institution.displayName,
      writingRulesVersion: input.writingRules.version,
      promptContractVersion: input.promptContract.version,
      documentStyleVersion: input.documentStyle.version,
      knowledgeVersion: validateKnowledgeBundleV1(knowledge).metadata.knowledgeVersion,
      supportedAppVersion: input.supportedAppVersion,
      builtAt: input.builtAt,
      sourceScope: input.scope,
      privacyReviewStatus: 'approved' as const,
      contentReviewStatus: 'approved' as const,
      fontRedistributionStatus:
        fontManifest.fonts.length === 0 ? ('not-applicable' as const) : ('approved' as const),
      artifacts: manifestArtifacts({
        institution,
        writingRules,
        promptContract,
        documentStyle,
        knowledge,
        fontsManifest,
      }),
    });
  const manifest = encode({ ...partial, bundleContentSha256: manifestHash(partial) });
  const bundle = {
    manifest,
    institution,
    writingRules,
    promptContract,
    documentStyle,
    knowledge,
    fontsManifest,
    fonts,
  };
  validateInstitutionBundleV1(bundle);
  return bundle;
};

export const institutionBundleResourcePaths = (): readonly string[] => [
  ...INSTITUTION_RESOURCE_PATHS,
];
