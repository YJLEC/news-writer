import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical.js';
import { buildApprovedKnowledgeBundleV1 } from './compile-approved.js';
import { sha256Bytes, sha256Text } from './hash.js';
import { approvedKnowledgeSourceV1Schema, knowledgeSourceManifestV1Schema } from './schemas.js';
import { extractKnowledgeCandidatesV1, parseKnowledgeSourceManifestV1 } from './source.js';

const pendingSource = (relativePath: string, sourceSha256: string) => ({
  sourceId: `src_${sha256Text(relativePath).slice(0, 16)}`,
  relativePath,
  sourceSha256,
  format: 'utf8-text' as const,
  projectPurposeAuthorizationId: 'synthetic-authorization',
  redistributionScope: 'internal-app' as const,
  redistributionReviewId: '',
  authorizationStatus: 'approved' as const,
  privacyReviewId: '',
  privacyReviewStatus: 'pending' as const,
});

const manifest = (source: Record<string, unknown>) => ({
  format: 'news-writer-knowledge-source-manifest' as const,
  schemaVersion: 1 as const,
  sourceRootSha256: sha256Text('synthetic-source-root'),
  sources: [source],
});

describe('development-only source pipeline', () => {
  it('extracts an explicitly listed UTF-8 source into a pending review candidate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'news-writer-source-'));
    const output = path.join(root, 'review');
    const relativePath = 'approved/source.txt';
    const sourcePath = path.join(root, ...relativePath.split('/'));
    await mkdir(path.dirname(sourcePath), { recursive: true });
    const sourceText = `合成资料核验活动\n\n活动使用两份公开材料。联系 ${['13800', '138000'].join('')}。`;
    const bytes = new TextEncoder().encode(sourceText);
    await writeFile(sourcePath, bytes);
    const candidates = await extractKnowledgeCandidatesV1({
      sourceRoot: root,
      outputDirectory: output,
      manifest: parseKnowledgeSourceManifestV1(
        manifest(pendingSource(relativePath, sha256Bytes(bytes))),
      ),
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      privacyReviewStatus: 'pending',
      redactionCounts: { phone: 1 },
    });
    expect(candidates[0]?.normalizedRedactedText).toContain('[已脱敏手机号]');
    const diskCandidate = JSON.parse(
      await readFile(path.join(output, `${candidates[0]?.sourceId}.json`), 'utf8'),
    ) as unknown;
    expect(canonicalJson(diskCandidate)).toBe(canonicalJson(candidates[0]));
  });

  it('rejects traversal, absolute paths, duplicate hashes and unknown fields', () => {
    const hash = sha256Text('source');
    expect(
      knowledgeSourceManifestV1Schema.safeParse(manifest(pendingSource('../x.txt', hash))).success,
    ).toBe(false);
    expect(
      knowledgeSourceManifestV1Schema.safeParse(manifest(pendingSource('C:/x.txt', hash))).success,
    ).toBe(false);
    expect(() =>
      parseKnowledgeSourceManifestV1({
        ...manifest(pendingSource('a.txt', hash)),
        sources: [pendingSource('a.txt', hash), pendingSource('b.txt', hash)],
      }),
    ).toThrow('Duplicate source hash');
    expect(
      knowledgeSourceManifestV1Schema.safeParse({
        ...manifest(pendingSource('a.txt', hash)),
        sourcePath: 'forbidden',
      }).success,
    ).toBe(false);
  });

  it('fails closed on a source hash mismatch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'news-writer-source-hash-'));
    await writeFile(path.join(root, 'source.txt'), '标题\n\n正文', 'utf8');
    await expect(
      extractKnowledgeCandidatesV1({
        sourceRoot: root,
        outputDirectory: path.join(root, 'review'),
        manifest: parseKnowledgeSourceManifestV1(
          manifest(pendingSource('source.txt', sha256Text('wrong'))),
        ),
      }),
    ).rejects.toThrow('Source hash mismatch');
  });

  it('does not accept pending records as formally approved sources', () => {
    expect(
      approvedKnowledgeSourceV1Schema.safeParse(pendingSource('source.txt', sha256Text('x')))
        .success,
    ).toBe(false);
  });

  it('compiles only when both the manifest and candidate carry completed reviews', () => {
    const hash = sha256Text('approved-source');
    const source = {
      ...pendingSource('source.txt', hash),
      redistributionReviewId: 'redistribution-review-1',
      privacyReviewId: 'privacy-review-1',
      privacyReviewStatus: 'approved' as const,
    };
    const candidate = {
      format: 'news-writer-knowledge-candidate' as const,
      schemaVersion: 1 as const,
      sourceId: source.sourceId,
      sourceSha256: hash,
      title: '合成标题',
      normalizedRedactedText: '合成正文',
      redactionCounts: {},
      authorizationStatus: 'approved' as const,
      privacyReviewStatus: 'approved' as const,
    };
    const metadata = {
      builtAt: '2099-01-02T03:04:05.6789012Z',
      authorizationBatchId: 'authorization-batch-1',
      privacyReviewBatchId: 'privacy-batch-1',
      builderVersion: 'test-builder-v1',
      builderSourceSha256: sha256Text('builder'),
      nodeVersion: '24-test',
      icuVersion: '78-test',
      unicodeVersion: '17-test',
      extractorVersions: { text: 'v1' },
      redactionRulesVersion: 'v1',
      duplicateCount: 0,
      redactionCountsByCategory: {},
    };
    expect(
      buildApprovedKnowledgeBundleV1({
        manifest: { ...manifest(source), sources: [source] },
        candidates: [candidate],
        trainingRules: 'R01 合成规则',
        metadata,
      }).corpus.byteLength,
    ).toBeGreaterThan(0);
    expect(() =>
      buildApprovedKnowledgeBundleV1({
        manifest: manifest(pendingSource('source.txt', hash)),
        candidates: [{ ...candidate, privacyReviewStatus: 'pending' }],
        trainingRules: 'R01 合成规则',
        metadata,
      }),
    ).toThrow();
  });
});
