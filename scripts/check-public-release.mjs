import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const forbiddenDirectoryNames = new Set([
  'node_modules',
  'dist',
  'out',
  'out-e2e',
  'out-package-smoke',
  'release',
  'coverage',
  'test-results',
  'playwright-report',
  'review',
  '公文字体安装包',
]);

const forbiddenExtensions = new Set([
  '.doc',
  '.docx',
  '.pdf',
  '.ppt',
  '.pptx',
  '.png',
  '.jpg',
  '.jpeg',
  '.zip',
  '.p12',
  '.pfx',
  '.pem',
  '.ttf',
  '.otf',
  '.ttc',
]);

const institutionResourceFiles = new Set([
  'resources/institution/manifest.json',
  'resources/institution/institution.json',
  'resources/institution/rules/writing-rules.json',
  'resources/institution/rules/prompt-contract.json',
  'resources/institution/rules/document-style.json',
  'resources/institution/knowledge/corpus.jsonl',
  'resources/institution/knowledge/index.json',
  'resources/institution/knowledge/training_rules.txt',
  'resources/institution/knowledge/metadata.json',
  'resources/institution/fonts/manifest.json',
]);

const forbiddenTextPatterns = [
  {
    name: 'institution identifier',
    pattern: /(?:PRIVATE_INSTITUTION|REAL_INSTITUTION|internal\.example\.edu)/iu,
  },
  { name: 'api key', pattern: /\b(?:sk|dk)-[a-z0-9_-]{16,}\b/iu },
  { name: 'bearer credential', pattern: /\bbearer\s+[a-z0-9._~+/=-]{16,}\b/iu },
  { name: 'phone number', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/u },
  { name: 'identity number', pattern: /(?<!\d)\d{17}[0-9Xx](?!\d)/u },
  { name: 'student number', pattern: /(?<!\d)(?:学号\s*[:：]?\s*)\d{10,12}(?!\d)/u },
  { name: 'wechat id', pattern: /(?:微信(?:号|ID)?|wechat)\s*[:：]?\s*[a-z][-_a-z0-9]{5,19}/iu },
  {
    name: 'email address',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  },
];

const pathSensitiveFiles = (relativePath) =>
  relativePath.startsWith('resources/') ||
  relativePath.startsWith('docs/') ||
  new Set([
    'README.md',
    'SECURITY.md',
    'CONTRIBUTING.md',
    'GOAL.md',
    'IMPLEMENTATION_PLAN.md',
    'electron-builder.yml',
    'electron-builder.package-smoke.yml',
  ]).has(relativePath);

const pathPattern =
  /(?:[A-Z]:\\(?:Users|workspace)\\(?:[^\s\\]+\\){1,3}|D:\\用户\\[^\s\\]+\\|\\\\(?!\?\\)[^\s\\]+\\[^\s\\]+)/u;

const toPosix = (value) => value.replaceAll('\\', '/');

const gitFiles = (args) =>
  execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' })
    .split(/\r?\n/u)
    .map((file) => file.trim())
    .filter(Boolean)
    .map(toPosix);

const stagedDiffFiles = gitFiles(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
const hasStagedIndex = stagedDiffFiles.length > 0;
const scanExcludedFiles = new Set(['scripts/check-public-release.mjs', 'pnpm-lock.yaml']);

export const listPublicFiles = () => {
  if (hasStagedIndex) return gitFiles(['ls-files', '--cached']);
  return gitFiles(['ls-files', '--cached', '--others', '--exclude-standard']);
};

const readPublicFile = (relativePath) => {
  if (hasStagedIndex) {
    try {
      return execFileSync('git', ['show', `:${relativePath}`], {
        cwd: repositoryRoot,
        encoding: 'buffer',
      });
    } catch {
      return null;
    }
  }
  const absolutePath = path.join(repositoryRoot, relativePath);
  if (!fs.existsSync(absolutePath)) return null;
  return fs.readFileSync(absolutePath);
};

const scanText = (relativePath, content) => {
  const findings = [];
  for (const { name, pattern } of forbiddenTextPatterns) {
    if (pattern.test(content)) findings.push(`${relativePath}: ${name}`);
  }
  if (pathSensitiveFiles(relativePath) && pathPattern.test(content)) {
    findings.push(`${relativePath}: user path`);
  }
  return findings;
};

export const validatePublicFiles = (files) => {
  const findings = [];
  const normalizedFiles = [...new Set(files.map(toPosix))].sort();
  for (const expected of institutionResourceFiles) {
    if (!normalizedFiles.includes(expected)) {
      findings.push(`${expected}: required synthetic public resource is missing`);
    }
  }
  for (const relativePath of normalizedFiles) {
    const segments = relativePath.split('/');
    if (segments.some((segment) => forbiddenDirectoryNames.has(segment))) {
      findings.push(`${relativePath}: private/build directory`);
      continue;
    }
    if (relativePath.startsWith('.env') || relativePath === 'auth.json') {
      findings.push(`${relativePath}: credential file`);
      continue;
    }
    if (forbiddenExtensions.has(path.extname(relativePath).toLowerCase())) {
      findings.push(`${relativePath}: binary/source material is not publishable`);
      continue;
    }
    if (
      relativePath.startsWith('resources/institution/') &&
      !institutionResourceFiles.has(relativePath)
    ) {
      findings.push(`${relativePath}: institution resource is outside the public allowlist`);
    }
    const bytes = readPublicFile(relativePath);
    if (!bytes) {
      findings.push(`${relativePath}: file is listed but missing from the worktree`);
      continue;
    }
    if (bytes.includes(0)) continue;
    if (relativePath !== 'THIRD-PARTY-NOTICES.txt' && !scanExcludedFiles.has(relativePath)) {
      findings.push(...scanText(relativePath, bytes.toString('utf8')));
    }
  }

  const manifestBytes = readPublicFile('resources/institution/manifest.json');
  if (manifestBytes) {
    try {
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      if (manifest.sourceScope !== 'synthetic-public-fixture') {
        findings.push('resources/institution/manifest.json: public sourceScope is not synthetic');
      }
      if (
        manifest.privacyReviewStatus !== 'approved' ||
        manifest.contentReviewStatus !== 'approved'
      ) {
        findings.push('resources/institution/manifest.json: synthetic profile is not approved');
      }
    } catch {
      findings.push('resources/institution/manifest.json: invalid JSON');
    }
  }
  for (const relativePath of normalizedFiles) {
    if (
      relativePath.startsWith('resources/institution/fonts/') &&
      relativePath !== 'resources/institution/fonts/manifest.json'
    ) {
      findings.push(`${relativePath}: public profile cannot include font files`);
    }
  }
  return findings;
};

export const runPublicReleaseCheck = () => {
  const files = listPublicFiles();
  const findings = validatePublicFiles(files);
  if (findings.length > 0) {
    for (const finding of findings) console.error(`PUBLIC RELEASE BLOCKED: ${finding}`);
    return false;
  }
  console.log(`Public release check passed for ${files.length} files.`);
  return true;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = runPublicReleaseCheck() ? 0 : 1;
}
