import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(import.meta.dirname, '..');

const require = createRequire(import.meta.url);
const { z } = require('../packages/institution/node_modules/zod/index.js');

const {
  buildInstitutionBundleV1,
  fontManifestV1Schema,
  institutionConfigV1Schema,
  loadInstitutionBundleFromResourcesPathV1,
  promptContractV1Schema,
  documentStyleV1Schema,
  writingRulesV1Schema,
} = await import(pathToFileURL(path.join(repositoryRoot, 'packages/institution/dist/index.js')));
const { findForbiddenKnowledgeTextPatternsV1, sha256Bytes } = await import(
  pathToFileURL(path.join(repositoryRoot, 'packages/retrieval/dist/index.js'))
);
const { buildApprovedKnowledgeBundleV1 } = await import(
  pathToFileURL(path.join(repositoryRoot, 'packages/retrieval/dist/development.js'))
);

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_AUDIT_BYTES = 2 * 1024 * 1024;

const relativePathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !value.includes('\\') && !value.includes(':') && !value.startsWith('/'))
  .refine((value) =>
    value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'),
  );

const inputSchema = z
  .object({
    format: z.literal('news-writer-private-profile-staging'),
    schemaVersion: z.literal(1),
    profile: z
      .object({
        profileId: z.string().regex(/^profile_[a-z0-9][a-z0-9-]{1,63}$/),
        profileVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        supportedAppVersion: z.string().trim().min(1).max(64),
        builtAt: z.string().datetime({ offset: true }),
      })
      .strict(),
    resources: z
      .object({
        institution: relativePathSchema,
        writingRules: relativePathSchema,
        promptContract: relativePathSchema,
        documentStyle: relativePathSchema,
        fontsManifest: relativePathSchema,
        knowledge: z
          .object({
            sourceManifest: relativePathSchema,
            candidates: z.array(relativePathSchema).min(1).max(10_000),
            trainingRules: relativePathSchema,
          })
          .strict(),
        fonts: z.array(relativePathSchema).max(100),
      })
      .strict(),
    metadata: z
      .object({
        authorizationBatchId: z.string().trim().min(1).max(128),
        privacyReviewBatchId: z.string().trim().min(1).max(128),
        builderVersion: z.string().trim().min(1).max(64),
        builderSourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
        nodeVersion: z.string().trim().min(1).max(64),
        icuVersion: z.string().trim().min(1).max(64),
        unicodeVersion: z.string().trim().min(1).max(64),
        extractorVersions: z.record(z.string().min(1).max(100), z.string().min(1).max(64)),
        redactionRulesVersion: z.string().trim().min(1).max(64),
      })
      .strict(),
    approvals: z
      .object({
        privacyReviewStatus: z.literal('approved'),
        contentReviewStatus: z.literal('approved'),
        fontRedistributionStatus: z.enum(['approved', 'not-applicable']),
        profileLicense: relativePathSchema,
        sourceAuthorization: relativePathSchema,
        fontLicenseRecord: relativePathSchema,
      })
      .strict(),
  })
  .strict();

const usage = () => {
  console.error('Usage: node scripts/build-private-profile.mjs --staging <dir> --output <dir>');
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(0);
  }
  const stagingIndex = args.indexOf('--staging');
  const outputIndex = args.indexOf('--output');
  if (stagingIndex < 0 || outputIndex < 0 || args.length !== 4)
    throw new Error('Invalid arguments.');
  const staging = args[stagingIndex + 1];
  const output = args[outputIndex + 1];
  if (!staging || !output) throw new Error('Both --staging and --output require a path.');
  return { staging: path.resolve(staging), output: path.resolve(output) };
};

const isInside = (candidate, parent) => {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const assertOutsideRepository = (candidate, label) => {
  if (isInside(candidate, repositoryRoot))
    throw new Error(`${label} must be outside the repository.`);
};

const ensureDirectory = async (directory, label) => {
  const info = await lstat(directory).catch(() => undefined);
  if (!info || !info.isDirectory() || info.isSymbolicLink())
    throw new Error(`${label} must be a regular directory.`);
};

const readUtf8 = async (filePath, label, max = MAX_INPUT_BYTES) => {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
  if (info.size > max) throw new Error(`${label} exceeds the size limit.`);
  return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(filePath));
};

const readBytes = async (filePath, label) => {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
  if (info.size > 200 * 1024 * 1024) throw new Error(`${label} exceeds the size limit.`);
  return new Uint8Array(await readFile(filePath));
};

const readJson = async (filePath, label) => {
  try {
    return JSON.parse(await readUtf8(filePath, label));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError)
      throw new Error(`${label} is not valid UTF-8 JSON.`);
    throw error;
  }
};

const resolveStagingPath = (root, relative, label) => {
  const parsed = relativePathSchema.parse(relative);
  const resolved = path.resolve(root, ...parsed.split('/'));
  if (!isInside(resolved, root)) throw new Error(`${label} escapes staging.`);
  return resolved;
};

const collectFiles = async (root) => {
  const files = [];
  const walk = async (directory, prefix) => {
    const entries = await readdir(directory);
    for (const name of entries) {
      const absolute = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Staging contains a symbolic link: ${relative}`);
      if (info.isDirectory()) await walk(absolute, relative);
      else if (info.isFile()) files.push(relative.replaceAll('\\', '/'));
      else throw new Error(`Staging contains an unsupported entry: ${relative}`);
    }
  };
  await walk(root, '');
  return files.sort();
};

const assertNoSensitiveText = (label, value) => {
  // Hashes are required provenance, not credential material. Remove only the
  // explicitly schema-controlled digest values before scanning free text.
  const scanValue = value.replace(
    /("(?:sha256|sourceSha256|sourceSetSha256|bundleContentSha256|builderSourceSha256|contentSha256)"\s*:\s*")([0-9a-f]{64})(")/giu,
    '$1$3',
  );
  const findings = findForbiddenKnowledgeTextPatternsV1(scanValue);
  if (findings.length > 0)
    throw new Error(`${label} contains forbidden text: ${findings.join(', ')}.`);
};

const encodeJson = (value) => new TextEncoder().encode(JSON.stringify(value));

const atomicWriteBundle = async (output, bundle) => {
  const parent = path.dirname(output);
  await mkdir(parent, { recursive: true });
  const temp = `${output}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(temp, { recursive: false });
  try {
    const writes = [
      ['manifest.json', bundle.manifest],
      ['institution.json', bundle.institution],
      ['rules/writing-rules.json', bundle.writingRules],
      ['rules/prompt-contract.json', bundle.promptContract],
      ['rules/document-style.json', bundle.documentStyle],
      ['knowledge/corpus.jsonl', bundle.knowledge.corpus],
      ['knowledge/index.json', bundle.knowledge.index],
      ['knowledge/training_rules.txt', bundle.knowledge.trainingRules],
      ['knowledge/metadata.json', bundle.knowledge.metadata],
      ['fonts/manifest.json', bundle.fontsManifest],
      ...Object.entries(bundle.fonts).map(([name, bytes]) => [`fonts/${name}`, bytes]),
    ];
    for (const [relative, bytes] of writes) {
      const destination = path.join(temp, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: 'wx' });
    }
    if (await lstat(output).catch(() => undefined))
      throw new Error('Output directory already exists; choose a new output path.');
    await rename(temp, output);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
};

const main = async () => {
  const { staging, output } = parseArgs();
  assertOutsideRepository(staging, 'Staging directory');
  assertOutsideRepository(output, 'Output directory');
  if (isInside(output, staging) || isInside(staging, output)) {
    throw new Error('Staging and output directories must be separate.');
  }
  await ensureDirectory(staging, 'Staging directory');
  const realStaging = await realpath(staging);
  assertOutsideRepository(realStaging, 'Staging directory');
  const outputParent = path.dirname(output);
  const realOutputParent = await realpath(outputParent).catch(() => outputParent);
  assertOutsideRepository(realOutputParent, 'Output parent directory');
  if (await lstat(output).catch(() => undefined))
    throw new Error('Output directory already exists; choose a new output path.');

  const input = inputSchema.parse(await readJson(path.join(staging, 'input.json'), 'input.json'));
  const explicit = new Set([
    'input.json',
    input.resources.institution,
    input.resources.writingRules,
    input.resources.promptContract,
    input.resources.documentStyle,
    input.resources.fontsManifest,
    input.resources.knowledge.sourceManifest,
    input.resources.knowledge.trainingRules,
    ...input.resources.knowledge.candidates,
    ...input.resources.fonts,
    input.approvals.profileLicense,
    input.approvals.sourceAuthorization,
    input.approvals.fontLicenseRecord,
  ]);
  const actual = await collectFiles(staging);
  const expected = [...explicit].sort();
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(
      'Staging contains missing or extra files; use the explicit input.json allowlist.',
    );
  }
  for (const auditPath of [
    input.approvals.profileLicense,
    input.approvals.sourceAuthorization,
    input.approvals.fontLicenseRecord,
  ]) {
    await readUtf8(
      resolveStagingPath(staging, auditPath, 'Approval file'),
      'Approval file',
      MAX_AUDIT_BYTES,
    );
  }

  const institution = institutionConfigV1Schema.parse(
    await readJson(
      resolveStagingPath(staging, input.resources.institution, 'Institution'),
      'Institution',
    ),
  );
  const writingRules = writingRulesV1Schema.parse(
    await readJson(
      resolveStagingPath(staging, input.resources.writingRules, 'Writing rules'),
      'Writing rules',
    ),
  );
  const promptContract = promptContractV1Schema.parse(
    await readJson(
      resolveStagingPath(staging, input.resources.promptContract, 'Prompt contract'),
      'Prompt contract',
    ),
  );
  const documentStyle = documentStyleV1Schema.parse(
    await readJson(
      resolveStagingPath(staging, input.resources.documentStyle, 'Document style'),
      'Document style',
    ),
  );
  const fontManifest = fontManifestV1Schema.parse(
    await readJson(
      resolveStagingPath(staging, input.resources.fontsManifest, 'Font manifest'),
      'Font manifest',
    ),
  );
  if (
    input.approvals.fontRedistributionStatus === 'not-applicable' &&
    fontManifest.fonts.length > 0
  )
    throw new Error('Fonts are present but redistribution status is not-applicable.');
  if (
    input.approvals.fontRedistributionStatus === 'approved' &&
    fontManifest.fonts.some((font) => !font.redistributable)
  )
    throw new Error('Font manifest contains a non-redistributable font.');

  const manifest = await readJson(
    resolveStagingPath(
      staging,
      input.resources.knowledge.sourceManifest,
      'Knowledge source manifest',
    ),
    'Knowledge source manifest',
  );
  const candidates = await Promise.all(
    input.resources.knowledge.candidates.map(async (candidatePath) =>
      readJson(
        resolveStagingPath(staging, candidatePath, 'Knowledge candidate'),
        'Knowledge candidate',
      ),
    ),
  );
  const trainingRules = await readUtf8(
    resolveStagingPath(staging, input.resources.knowledge.trainingRules, 'Training rules'),
    'Training rules',
  );
  const knowledge = buildApprovedKnowledgeBundleV1({
    manifest,
    candidates,
    trainingRules,
    sourceScope: 'approved-private-profile',
    metadata: input.metadata,
  });
  const fonts = {};
  for (const font of fontManifest.fonts) {
    const relative = `fonts/${font.fileName}`;
    if (!input.resources.fonts.includes(relative))
      throw new Error(`Font ${font.fileName} is missing from the explicit allowlist.`);
    const bytes = await readBytes(resolveStagingPath(staging, relative, 'Font'), 'Font');
    if (sha256Bytes(bytes) !== font.sha256)
      throw new Error(`Font hash mismatch: ${font.fileName}.`);
    fonts[font.fileName] = bytes;
  }
  if (input.resources.fonts.length !== fontManifest.fonts.length)
    throw new Error('Font allowlist does not match font manifest.');

  const bundle = buildInstitutionBundleV1({
    scope: 'approved-private-profile',
    profileId: input.profile.profileId,
    profileVersion: input.profile.profileVersion,
    supportedAppVersion: input.profile.supportedAppVersion,
    builtAt: input.profile.builtAt,
    institution,
    writingRules,
    promptContract,
    documentStyle,
    knowledge,
    fonts,
    fontManifest,
  });
  for (const [label, bytes] of [
    ['institution', bundle.institution],
    ['writing rules', bundle.writingRules],
    ['prompt contract', bundle.promptContract],
    ['document style', bundle.documentStyle],
    ['font manifest', bundle.fontsManifest],
    ['corpus', bundle.knowledge.corpus],
    ['index', bundle.knowledge.index],
    ['training rules', bundle.knowledge.trainingRules],
    ['knowledge metadata', bundle.knowledge.metadata],
  ])
    assertNoSensitiveText(label, new TextDecoder().decode(bytes));
  await atomicWriteBundle(output, bundle);
  try {
    await loadInstitutionBundleFromResourcesPathV1(output);
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  console.log(
    JSON.stringify(
      {
        profileId: input.profile.profileId,
        profileVersion: input.profile.profileVersion,
        knowledgeVersion: JSON.parse(new TextDecoder().decode(bundle.knowledge.metadata))
          .knowledgeVersion,
        output,
        files: (await collectFiles(output)).sort(),
      },
      null,
      2,
    ),
  );
};

main().catch((error) => {
  console.error(
    `Private profile build failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
