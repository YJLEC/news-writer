import { access, cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { validateKnowledgeBundleV1 } from '@news-writer/retrieval';
import type { ValidatedKnowledgeBundleV1 } from '@news-writer/retrieval';
import { describe, expect, it } from 'vitest';

import { ProjectService } from './project-service.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const fixtureRoot = path.join(repositoryRoot, 'tests', 'golden', 'retrieval');

const loadFixtureBundle = async (): Promise<ValidatedKnowledgeBundleV1> =>
  validateKnowledgeBundleV1({
    corpus: await readFile(path.join(fixtureRoot, 'mini-corpus.jsonl')),
    index: await readFile(path.join(fixtureRoot, 'mini-index.json')),
    trainingRules: await readFile(
      path.join(repositoryRoot, 'tests', 'fixtures', 'retrieval', 'training-rules.txt'),
    ),
    metadata: await readFile(path.join(fixtureRoot, 'mini-metadata.json')),
  });

const createService = async (bundle?: ValidatedKnowledgeBundleV1) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nw-retrieval-service-'));
  const target = path.join(root, 'project');
  const service = new ProjectService(
    {
      chooseNewProject: async () => target,
      chooseExistingProject: async () => target,
      chooseMinutesFile: async () => undefined,
    },
    { appVersion: '0.1.0', electronVersion: '43.3.0', chromiumVersion: '150.0.0' },
    undefined,
    undefined,
    undefined,
    undefined,
    bundle,
  );
  const created = await service.createWithDialog(
    { name: 'retrieval test', profile: 'official', initialMinutes: '2098 event minutes' },
    10,
  );
  if (created.cancelled) throw new Error('unexpected cancellation');
  return { root, service, view: created.data };
};

describe('ProjectService read-only retrieval integration', () => {
  it('records hits, redacts the query, and includes the persisted report in Prompt preparation', async () => {
    const fixture = await createService(await loadFixtureBundle());
    const syntheticApiKey = ['s', 'k-', 'test-key-', '1234567890123456'].join('');
    const syntheticPhone = ['13800', '138000'].join('');
    const syntheticEmail = ['editor', '@example.invalid'].join('');
    try {
      const result = await fixture.service.searchRetrieval(
        {
          sessionId: fixture.view.sessionId,
          expectedRevision: fixture.view.revision,
          query: `2098 ${syntheticPhone} ${syntheticEmail} ${syntheticApiKey}`,
          topK: 2,
        },
        10,
      );
      expect(result.hits).toHaveLength(2);
      expect(result.project.retrievalReports).toHaveLength(1);
      const aggregate = fixture.service.getOwned(fixture.view.sessionId, 10).aggregate;
      const report = aggregate.retrievalReports[0];
      expect(report?.redactedQueryText).not.toContain(syntheticPhone);
      expect(report?.redactedQueryText).not.toContain(syntheticEmail);
      expect(report?.redactedQueryText).not.toContain(syntheticApiKey);
      await expect(
        fixture.service.searchRetrieval(
          {
            sessionId: fixture.view.sessionId,
            expectedRevision: result.project.revision,
            query: 'C:\\Users\\private\\minutes.docx',
            topK: 1,
          },
          10,
        ),
      ).rejects.toMatchObject({ safe: { code: 'CONTENT_INVALID' } });
      const prepared = await fixture.service.preparePrompt(
        {
          sessionId: fixture.view.sessionId,
          expectedRevision: result.project.revision,
          kind: 'draftGeneration',
          parentVersionId: null,
          retrievalReportId: result.reportId,
        },
        10,
      );
      expect(prepared.messages[0]?.content).toContain('历史参考稿');
      expect(prepared.messages[0]?.content).toContain(result.hits[0]?.title);
    } finally {
      await fixture.service.closeAll();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('distinguishes zero hits from unavailable resources and enforces session state', async () => {
    const fixture = await createService(await loadFixtureBundle());
    const unavailable = await createService();
    try {
      const zero = await fixture.service.searchRetrieval(
        {
          sessionId: fixture.view.sessionId,
          expectedRevision: fixture.view.revision,
          query: 'no-such-reference-term',
          topK: 5,
        },
        10,
      );
      expect(zero.hits).toEqual([]);
      expect(zero.project.retrievalReports).toHaveLength(1);
      await expect(
        unavailable.service.searchRetrieval(
          {
            sessionId: unavailable.view.sessionId,
            expectedRevision: unavailable.view.revision,
            query: '2098',
            topK: 5,
          },
          10,
        ),
      ).rejects.toMatchObject({ safe: { code: 'RESOURCE_UNAVAILABLE' } });
      await expect(
        fixture.service.searchRetrieval(
          {
            sessionId: fixture.view.sessionId,
            expectedRevision: fixture.view.revision,
            query: '2098',
            topK: 5,
          },
          99,
        ),
      ).rejects.toMatchObject({ safe: { code: 'IPC_SENDER_REJECTED' } });
      await expect(
        fixture.service.searchRetrieval(
          {
            sessionId: fixture.view.sessionId,
            expectedRevision: fixture.view.revision - 1,
            query: '2098',
            topK: 5,
          },
          10,
        ),
      ).rejects.toMatchObject({ safe: { code: 'PROJECT_CONFLICT' } });
    } finally {
      await fixture.service.closeAll();
      await unavailable.service.closeAll();
      await rm(fixture.root, { recursive: true, force: true });
      await rm(unavailable.root, { recursive: true, force: true });
    }
  });

  it('rejects archived projects without writing a report', async () => {
    const fixture = await createService(await loadFixtureBundle());
    try {
      const archived = await fixture.service.setArchived(
        {
          sessionId: fixture.view.sessionId,
          expectedRevision: fixture.view.revision,
          archived: true,
        },
        10,
      );
      await expect(
        fixture.service.searchRetrieval(
          {
            sessionId: archived.sessionId,
            expectedRevision: archived.revision,
            query: '2098',
            topK: 5,
          },
          10,
        ),
      ).rejects.toMatchObject({ safe: { code: 'PROJECT_STATE_CONFLICT' } });
      expect(fixture.service.getOwned(archived.sessionId, 10).aggregate.retrievalReports).toEqual(
        [],
      );
    } finally {
      await fixture.service.closeAll();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('keeps retrieval records after reopening a copied project directory', async () => {
    const fixture = await createService(await loadFixtureBundle());
    let copiedRoot: string | undefined;
    try {
      const result = await fixture.service.searchRetrieval(
        {
          sessionId: fixture.view.sessionId,
          expectedRevision: fixture.view.revision,
          query: '2098',
          topK: 1,
        },
        10,
      );
      await fixture.service.close(
        { sessionId: result.project.sessionId, expectedRevision: result.project.revision },
        10,
      );
      copiedRoot = await mkdtemp(path.join(os.tmpdir(), 'nw-retrieval-copy-'));
      await cp(path.join(fixture.root, 'project'), path.join(copiedRoot, 'project'), {
        recursive: true,
      });
      const reopened = new ProjectService(
        {
          chooseNewProject: async () => undefined,
          chooseExistingProject: async () => path.join(copiedRoot!, 'project'),
          chooseMinutesFile: async () => undefined,
        },
        { appVersion: '0.1.0', electronVersion: '43.3.0', chromiumVersion: '150.0.0' },
        undefined,
        undefined,
        undefined,
        undefined,
        await loadFixtureBundle(),
      );
      const opened = await reopened.openWithDialog(11);
      if (opened.cancelled || 'recoveryRequired' in opened)
        throw new Error('unexpected cancellation');
      expect(opened.data.retrievalReports).toHaveLength(1);
      expect(opened.data.revision).toBe(result.project.revision);
      await reopened.close(
        { sessionId: opened.data.sessionId, expectedRevision: opened.data.revision },
        11,
      );
      await expect(access(path.join(copiedRoot, 'resources', 'knowledge'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await fixture.service.closeAll();
      await rm(fixture.root, { recursive: true, force: true });
      if (copiedRoot !== undefined) await rm(copiedRoot, { recursive: true, force: true });
    }
  });
});
