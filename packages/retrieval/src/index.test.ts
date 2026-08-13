import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildKnowledgeBundleV1,
  buildRetrievalIndexV1,
  canonicalJson,
  findForbiddenKnowledgeTextPatternsV1,
  formatPromptReferencesV1,
  loadKnowledgeBundleFromResourcesPathV1,
  normalizeRetrievalTextV1,
  redactKnowledgeCandidateV1,
  searchRetrievalIndexV1,
  serializeCorpusJsonlV1,
  sha256Bytes,
  sha256Text,
  tokenizeRetrievalTextV1,
  validateKnowledgeBundleV1,
} from './index.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const fixtureDirectory = path.join(repositoryRoot, 'tests', 'fixtures', 'retrieval', 'documents');
const goldenDirectory = path.join(repositoryRoot, 'tests', 'golden', 'retrieval');

const readSyntheticInputs = async () => {
  const fileNames = [
    'r01-digital-source-check-workshop.md',
    'r02-weather-observation-open-day.md',
    'r03-community-energy-observation.md',
    'r04-campus-space-safety-check.md',
    'r05-campus-chorus-open-session.md',
  ];
  const documents = await Promise.all(
    fileNames.map(async (fileName) => {
      const markdown = await readFile(path.join(fixtureDirectory, fileName), 'utf8');
      const [heading, ...body] = markdown.trim().split('\n');
      if (heading === undefined) throw new Error('Missing fixture heading.');
      return { title: heading.slice(2), text: body.join('\n').trim() };
    }),
  );
  const trainingRules = await readFile(
    path.join(repositoryRoot, 'tests', 'fixtures', 'retrieval', 'training-rules.txt'),
    'utf8',
  );
  return { documents, trainingRules, fileNames };
};

const buildSyntheticBundle = async () => {
  const { documents, trainingRules, fileNames } = await readSyntheticInputs();
  return buildKnowledgeBundleV1({
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
};

describe('retrieval normalization and tokenizer', () => {
  it('matches GF-13 and remains idempotent', async () => {
    const input = await readFile(
      path.join(repositoryRoot, 'tests', 'fixtures', 'text', 'gf-13-normalization.input.txt'),
      'utf8',
    );
    const expected = (
      await readFile(
        path.join(repositoryRoot, 'tests', 'fixtures', 'text', 'gf-13-normalization.expected.txt'),
        'utf8',
      )
    ).trim();
    const actual = normalizeRetrievalTextV1(input);
    expect(actual).toBe(expected);
    expect(normalizeRetrievalTextV1(actual)).toBe(actual);
  });

  it('normalizes NFKC, controls, CRLF and entities in the specified order', () => {
    expect(normalizeRetrievalTextV1('ＡＢＣ&nbsp;\0甲\r\n\u0001乙\n\n\n丙')).toBe(
      'ABC 甲\n 乙\n\n丙',
    );
  });

  it('emits ASCII and BMP/astral Han n-grams by code point', () => {
    expect(tokenizeRetrievalTextV1(normalizeRetrievalTextV1('ＡBc12,甲乙丙!𠀀丁'))).toEqual([
      'abc12',
      '甲',
      '乙',
      '丙',
      '甲乙',
      '乙丙',
      '甲乙丙',
      '𠀀',
      '丁',
      '𠀀丁',
    ]);
  });
});

describe('BM25 V1', () => {
  it('matches a hand-calculated score and caps query TF at three', () => {
    const index = buildRetrievalIndexV1(
      [
        { documentId: 'news_000000000000000000000001', normalizedText: 'alpha alpha beta' },
        { documentId: 'news_000000000000000000000002', normalizedText: 'alpha gamma' },
      ],
      '0'.repeat(64),
    );
    const result = searchRetrievalIndexV1(index, 'alpha');
    const idf = Math.log(1 + (2 - 2 + 0.5) / (2 + 0.5));
    const expected = idf * ((2 * 2.5) / (2 + 1.5 * (0.25 + (0.75 * 3) / 2.5)));
    expect(result[0]?.rawScore).toBeCloseTo(expected, 12);
    expect(searchRetrievalIndexV1(index, 'alpha alpha alpha alpha')[0]?.rawScore).toBeCloseTo(
      expected * 3,
      12,
    );
  });

  it('uses document ID tie-break and validates topK boundaries', () => {
    const index = buildRetrievalIndexV1(
      [
        { documentId: 'news_000000000000000000000002', normalizedText: 'alpha x' },
        { documentId: 'news_000000000000000000000001', normalizedText: 'alpha y' },
      ],
      '0'.repeat(64),
    );
    expect(searchRetrievalIndexV1(index, 'alpha').map((hit) => hit.documentId)).toEqual([
      'news_000000000000000000000001',
      'news_000000000000000000000002',
    ]);
    expect(searchRetrievalIndexV1(index, 'alpha', 0)).toEqual([]);
    expect(() => searchRetrievalIndexV1(index, 'alpha', 21)).toThrow(RangeError);
    expect(() => searchRetrievalIndexV1(index, 'alpha', 1.5)).toThrow(RangeError);
  });

  it('treats empty, punctuation-only and legal no-match queries as non-errors', async () => {
    const bundle = validateKnowledgeBundleV1(await buildSyntheticBundle());
    expect(searchRetrievalIndexV1(bundle.index, '')).toEqual([]);
    expect(searchRetrievalIndexV1(bundle.index, '...')).toEqual([]);
    const noMatch = await readFile(
      path.join(repositoryRoot, 'tests', 'fixtures', 'retrieval', 'no-match-query.txt'),
      'utf8',
    );
    expect(searchRetrievalIndexV1(bundle.index, normalizeRetrievalTextV1(noMatch))).toEqual([]);
  });
});

describe('knowledge bundle', () => {
  it('rebuilds the five-document mini bundle byte-for-byte', async () => {
    const first = await buildSyntheticBundle();
    const second = await buildSyntheticBundle();
    expect(first).toEqual(second);
    expect(Buffer.from(first.corpus)).toEqual(
      await readFile(path.join(goldenDirectory, 'mini-corpus.jsonl')),
    );
    expect(Buffer.from(first.index)).toEqual(
      await readFile(path.join(goldenDirectory, 'mini-index.json')),
    );
    expect(Buffer.from(first.metadata)).toEqual(
      await readFile(path.join(goldenDirectory, 'mini-metadata.json')),
    );
  });

  it('rejects corpus/index/hash/schema corruption', async () => {
    const bundle = await buildSyntheticBundle();
    const validated = validateKnowledgeBundleV1(bundle);
    const first = validated.records[0];
    expect(first).toBeDefined();
    const corruptCorpus = `${serializeCorpusJsonlV1([
      { ...first!, normalizedText: `${first!.normalizedText}篡改` },
      ...validated.records.slice(1),
    ])}`;
    expect(() =>
      validateKnowledgeBundleV1({ ...bundle, corpus: new TextEncoder().encode(corruptCorpus) }),
    ).toThrow();

    const index = JSON.parse(new TextDecoder().decode(bundle.index)) as Record<string, unknown>;
    expect(() =>
      validateKnowledgeBundleV1({
        ...bundle,
        index: new TextEncoder().encode(canonicalJson({ ...index, unknown: true })),
      }),
    ).toThrow();
  });

  it('loads only the exact fixed files and rejects extras', async () => {
    const bundle = await buildSyntheticBundle();
    const root = await mkdtemp(path.join(os.tmpdir(), 'news-writer-retrieval-'));
    const knowledge = path.join(root, 'knowledge');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(knowledge));
    await Promise.all([
      writeFile(path.join(knowledge, 'corpus.jsonl'), bundle.corpus),
      writeFile(path.join(knowledge, 'index.json'), bundle.index),
      writeFile(path.join(knowledge, 'training_rules.txt'), bundle.trainingRules),
      writeFile(path.join(knowledge, 'metadata.json'), bundle.metadata),
    ]);
    expect((await loadKnowledgeBundleFromResourcesPathV1(root)).records).toHaveLength(5);
    await writeFile(path.join(knowledge, 'extra.txt'), 'not allowed');
    await expect(loadKnowledgeBundleFromResourcesPathV1(root)).rejects.toMatchObject({
      code: 'KNOWLEDGE_RESOURCE_INVALID',
    });
  });
});

describe('redaction and prompt snapshots', () => {
  it('redacts supported credential/contact shapes and detects paths', () => {
    const sensitive = [
      '联系 138',
      '00138000，邮箱 user',
      '@example.invalid，Bearer sk-',
      'a'.repeat(20),
    ].join('');
    const result = redactKnowledgeCandidateV1(sensitive);
    expect(result.counts.phone).toBe(1);
    expect(result.counts.email).toBe(1);
    expect(result.counts.apiKey).toBe(1);
    expect(findForbiddenKnowledgeTextPatternsV1('C:\\Users\\Example')).toContain('absolutePath');
  });

  it('formats immutable report excerpts without reopening the bundle', async () => {
    const reports = JSON.parse(
      await readFile(path.join(goldenDirectory, 'query-reports.json'), 'utf8'),
    ) as { hits: unknown[] }[];
    expect(reports[0]?.hits).toHaveLength(2);
    expect(reports[2]?.hits).toEqual([]);
    const report = reports[0];
    if (report === undefined) throw new Error('Missing golden report.');
    const block = formatPromptReferencesV1(report as never);
    expect(block).toContain('不是本次活动的事实来源');
    expect(block).toContain('[参考 1]');
    expect(formatPromptReferencesV1(reports[2] as never)).toContain('未检索到相似旧稿');
  });

  it('hashes the actual normalized redacted query bytes', () => {
    expect(sha256Bytes(new TextEncoder().encode('查询'))).toBe(sha256Text('查询'));
  });
});
