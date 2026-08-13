export const INSTITUTION_RESOURCE_PATHS = [
  'institution.json',
  'rules/writing-rules.json',
  'rules/prompt-contract.json',
  'rules/document-style.json',
  'knowledge/corpus.jsonl',
  'knowledge/index.json',
  'knowledge/training_rules.txt',
  'knowledge/metadata.json',
  'fonts/manifest.json',
] as const;

export type InstitutionResourcePath = (typeof INSTITUTION_RESOURCE_PATHS)[number];

export const INSTITUTION_PROFILE_SCOPES = [
  'synthetic-public-fixture',
  'approved-private-profile',
] as const;

export const institutionPackageName = '@news-writer/institution' as const;
