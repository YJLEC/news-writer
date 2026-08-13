import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { retrievalReportIdSchema } from '@news-writer/shared';

import { buildKnowledgeBundleV1 } from './build.js';
import { canonicalJson } from './canonical.js';
import { sha256Text } from './hash.js';
import { validateKnowledgeBundleV1 } from './bundle.js';
import { buildRetrievalReportV1 } from './report.js';

const repositoryRoot = path.resolve(process.argv[2] ?? '.');
const fixtureDirectory = path.join(repositoryRoot, 'tests', 'fixtures', 'retrieval', 'documents');
const rulesPath = path.join(repositoryRoot, 'tests', 'fixtures', 'retrieval', 'training-rules.txt');
const outputDirectory = path.join(repositoryRoot, 'tests', 'golden', 'retrieval');
const fileNames = [
  'r01-digital-source-check-workshop.md',
  'r02-weather-observation-open-day.md',
  'r03-community-energy-observation.md',
  'r04-campus-space-safety-check.md',
  'r05-campus-chorus-open-session.md',
] as const;

const documents = await Promise.all(
  fileNames.map(async (fileName) => {
    const markdown = await readFile(path.join(fixtureDirectory, fileName), 'utf8');
    const [heading, ...body] = markdown.trim().split('\n');
    if (heading === undefined || !heading.startsWith('# '))
      throw new Error('Invalid fixture heading.');
    return { title: heading.slice(2), text: body.join('\n').trim() };
  }),
);
const trainingRules = await readFile(rulesPath, 'utf8');
const bundle = buildKnowledgeBundleV1({
  documents,
  trainingRules,
  metadata: {
    builtAt: '2099-01-02T03:04:05.6789012Z',
    sourceScope: 'synthetic-public-fixture',
    sourceSetSha256: sha256Text(canonicalJson(fileNames)),
    authorizationBatchId: 'synthetic-fixture-authorization-v1',
    privacyReviewBatchId: 'synthetic-fixture-privacy-v1',
    builderVersion: 'synthetic-golden-builder-v1',
    builderSourceSha256: sha256Text('synthetic-golden-builder-v1'),
    nodeVersion: '24.18.0-test-fixture',
    icuVersion: '78.3-test-fixture',
    unicodeVersion: '17.0-test-fixture',
    extractorVersions: { markdown: 'synthetic-v1' },
    redactionRulesVersion: 'synthetic-redaction-v1',
    approvedSourceCount: documents.length,
    rejectedSourceCount: 0,
    duplicateCount: 0,
    redactionCountsByCategory: {},
    totalCharacters: 0,
    totalTokens: 0,
  },
});
const validated = validateKnowledgeBundleV1(bundle);
const emptyFactHints = { dates: [], times: [], locations: [], participants: [], missing: [] };
const queries = [
  ['00000000-0000-4000-8000-000000000071', '资料来源核验'],
  ['00000000-0000-4000-8000-000000000072', '微气候观测'],
  [
    '00000000-0000-4000-8000-000000000073',
    await readFile(
      path.join(repositoryRoot, 'tests', 'fixtures', 'retrieval', 'no-match-query.txt'),
      'utf8',
    ),
  ],
].map(([id, query]) =>
  buildRetrievalReportV1(validated, {
    id: retrievalReportIdSchema.parse(id),
    createdAt: '2099-01-02T03:04:05.6789012Z',
    redactedText: query ?? '',
    factHints: emptyFactHints,
  }),
);

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(path.join(outputDirectory, 'mini-corpus.jsonl'), bundle.corpus),
  writeFile(path.join(outputDirectory, 'mini-index.json'), bundle.index),
  writeFile(path.join(outputDirectory, 'mini-metadata.json'), bundle.metadata),
  writeFile(path.join(outputDirectory, 'query-reports.json'), canonicalJson(queries), 'utf8'),
]);
