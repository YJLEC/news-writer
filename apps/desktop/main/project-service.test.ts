import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_GENERATION_CONFIG,
  queueTask,
  transitionTask,
  type ProjectAggregateV1,
} from '@news-writer/domain';
import {
  lockOwnerV1Schema,
  makeCommitId,
  makeTransactionId,
  ProjectSession,
  serializeJson,
} from '@news-writer/project';
import {
  projectRelativePathSchema,
  sha256Schema,
  systemClock,
  textArtifactRefSchema,
  versionIdSchema,
} from '@news-writer/shared';
import { exportDocumentResultDtoSchema, projectViewDtoSchema } from '@news-writer/shared/ipc';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setCommitBarrierForTest } from '../../../packages/project/dist/faults.js';

import { ProjectService } from './project-service.js';
import { SafeMainError } from './ipc-core.js';
import { SerialLinearizationGate } from './linearization.js';
import { UserConfigService } from './user-config-service.js';

const roots: string[] = [];
afterEach(async () => {
  setCommitBarrierForTest();
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

const setup = async (minutesFile?: string) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'nw-main-project-'));
  roots.push(parent);
  const target = path.join(parent, '中文 项目目录');
  let createTarget: string | undefined = target;
  const service = new ProjectService(
    {
      chooseNewProject: async () => createTarget,
      chooseExistingProject: async () => target,
      chooseMinutesFile: async () => minutesFile,
    },
    {
      appVersion: '0.1.0',
      electronVersion: '43.3.0',
      chromiumVersion: '150.0.0',
    },
  );
  const created = await service.createWithDialog(
    { name: '合成项目', profile: 'official', initialMinutes: '活动纪要。' },
    10,
  );
  if (created.cancelled) throw new Error('unexpected cancellation');
  createTarget = undefined;
  return { service, view: created.data, target };
};

const setupWithCredential = async (configuredKey: string, minutesFile?: string) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'nw-main-secret-project-'));
  roots.push(parent);
  const target = path.join(parent, 'project');
  const service = new ProjectService(
    {
      chooseNewProject: async () => target,
      chooseExistingProject: async () => target,
      chooseMinutesFile: async () => minutesFile,
    },
    {
      appVersion: '0.1.0',
      electronVersion: '43.3.0',
      chromiumVersion: '150.0.0',
    },
    { readConfiguredApiKey: async () => configuredKey },
  );
  const created = await service.createWithDialog(
    { name: 'safe project', profile: 'official', initialMinutes: 'safe minutes' },
    10,
  );
  if (created.cancelled) throw new Error('unexpected cancellation');
  return { service, view: created.data, target };
};

const runtime = {
  appVersion: '0.1.0',
  electronVersion: '43.3.0',
  chromiumVersion: '150.0.0',
};

const openOnlyService = (target: string) =>
  new ProjectService(
    {
      chooseNewProject: async () => undefined,
      chooseExistingProject: async () => target,
      chooseMinutesFile: async () => undefined,
    },
    runtime,
  );

const writeStaleLock = async (target: string, instanceId = randomUUID()) => {
  const lockRoot = path.join(target, '.news-writer', 'write.lock');
  await mkdir(lockRoot);
  const staleAt = '2000-01-01T00:00:00.000Z';
  const owner = lockOwnerV1Schema.parse({
    format: 'news-writer-lock-owner',
    storageVersion: 1,
    instanceId,
    pid: 2_147_483_647,
    processStartedAt: staleAt,
    appVersion: runtime.appVersion,
    heartbeatAt: staleAt,
  });
  await writeFile(path.join(lockRoot, 'owner.json'), serializeJson(owner));
  const old = new Date(staleAt);
  await utimes(lockRoot, old, old);
  return owner.instanceId;
};

const setupStaleLock = async () => {
  const { service, view, target } = await setup();
  await service.close({ sessionId: view.sessionId, expectedRevision: view.revision }, 10);
  const observedInstanceId = await writeStaleLock(target);
  return { target, observedInstanceId, service: openOnlyService(target) };
};

const persistActiveTask = async (
  project: ProjectSession,
  targetStatus: 'queued' | 'preparing' | 'requesting' | 'processing' | 'saving',
): Promise<ProjectAggregateV1> => {
  const promptId = randomUUID();
  const taskId = randomUUID();
  const prompt = 'synthetic recovery prompt';
  const bytes = Buffer.from(prompt, 'utf8');
  const contentRef = textArtifactRefSchema.parse({
    relativePath: projectRelativePathSchema.parse(`content/prompts/${taskId}/0.txt`),
    sha256: sha256Schema.parse(createHash('sha256').update(bytes).digest('hex')),
    byteLength: bytes.byteLength,
    mediaType: 'text/plain',
    encoding: 'utf-8',
  });
  const runtime = {
    appVersion: '0.1.0',
    electronVersion: '43.3.0',
    chromiumVersion: '150.0.0',
  };
  const ids = [promptId, taskId];
  let current = project.read();
  let next = queueTask(
    current,
    {
      kind: 'draftGeneration',
      messages: [{ role: 'user', contentRef }],
      editedByUser: false,
      upstream: {
        promptInputFingerprint: sha256Schema.parse(
          createHash('sha256').update(prompt).digest('hex'),
        ),
        currentInputFingerprint: sha256Schema.parse(
          createHash('sha256').update(prompt).digest('hex'),
        ),
        staleResolution: 'current',
      },
      config: { defaults: DEFAULT_GENERATION_CONFIG },
    },
    current.revision,
    { ids: { next: () => ids.shift() ?? randomUUID() }, clock: systemClock, runtime },
  );
  await project.commit({
    transactionId: makeTransactionId(),
    commitId: makeCommitId(),
    expectedRevision: current.revision,
    expectedHeadCommitId: project.headCommitId,
    nextAggregate: next,
    artifacts: new Map([[contentRef.relativePath, prompt]]),
  });
  const stages = ['preparing', 'requesting', 'processing', 'saving'] as const;
  for (const status of stages) {
    if (targetStatus === 'queued') break;
    current = project.read();
    next = transitionTask(
      current,
      current.tasks[0]!.id,
      status === 'saving'
        ? {
            status,
            successTransactionId: randomUUID(),
            proposedVersionId: versionIdSchema.parse(randomUUID()),
          }
        : { status },
      current.revision,
      systemClock.now(),
      runtime,
    );
    await project.commit({
      transactionId: makeTransactionId(),
      commitId: makeCommitId(),
      expectedRevision: current.revision,
      expectedHeadCommitId: project.headCommitId,
      nextAggregate: next,
    });
    if (status === targetStatus) break;
  }
  return project.read();
};

describe('ProjectService', () => {
  it('exports an arbitrary successful version and records only safe metadata', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'nw-main-export-'));
    roots.push(parent);
    const target = path.join(parent, 'project');
    await cp(path.resolve('tests/fixtures/projects/linear'), target, { recursive: true });
    const output = path.join(parent, '导出的新闻稿.docx');
    const worker = {
      generate: vi.fn(async () => new Uint8Array([80, 75, 3, 4, 9])),
      shutdown: vi.fn(async () => undefined),
    };
    const service = new ProjectService(
      {
        chooseNewProject: async () => undefined,
        chooseExistingProject: async () => target,
        chooseMinutesFile: async () => undefined,
        chooseExportPath: async () => output,
      },
      runtime,
      undefined,
      new SerialLinearizationGate(),
      undefined,
      worker,
    );
    const opened = await service.openWithDialog(10);
    if (opened.cancelled || 'recoveryRequired' in opened) throw new Error('unexpected open result');
    const versionId = opened.data.versions[0]!.id;
    const exported = await service.exportDocumentWithDialog(
      { sessionId: opened.data.sessionId, expectedRevision: opened.data.revision, versionId },
      10,
    );
    expect(exported.cancelled).toBe(false);
    expect(exportDocumentResultDtoSchema.parse(exported)).toBeDefined();
    if (!exported.cancelled && !exported.needsInput) {
      expect(exported.record).toMatchObject({
        versionId,
        status: 'succeeded',
        fileName: '导出的新闻稿.docx',
      });
      expect(exported.project.latestVersionId).toBe(opened.data.latestVersionId);
      expect(exported.project.exportRecords).toHaveLength(opened.data.exportRecords.length + 1);
      expect(JSON.stringify(exported)).not.toContain(output);
    }
    expect(new Uint8Array(await readFile(output))).toEqual(new Uint8Array([80, 75, 3, 4, 9]));
  });

  it('keeps dialog cancellation at zero side effects', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'nw-main-export-cancel-'));
    roots.push(parent);
    const target = path.join(parent, 'project');
    await cp(path.resolve('tests/fixtures/projects/linear'), target, { recursive: true });
    const worker = {
      generate: vi.fn(async () => new Uint8Array([1])),
      shutdown: vi.fn(async () => undefined),
    };
    const service = new ProjectService(
      {
        chooseNewProject: async () => undefined,
        chooseExistingProject: async () => target,
        chooseMinutesFile: async () => undefined,
        chooseExportPath: async () => undefined,
      },
      runtime,
      undefined,
      new SerialLinearizationGate(),
      undefined,
      worker,
    );
    const opened = await service.openWithDialog(10);
    if (opened.cancelled || 'recoveryRequired' in opened) throw new Error('unexpected open result');
    const result = await service.exportDocumentWithDialog(
      {
        sessionId: opened.data.sessionId,
        expectedRevision: opened.data.revision,
        versionId: opened.data.versions[0]!.id,
      },
      10,
    );
    expect(result).toEqual({ cancelled: true });
    expect(worker.generate).not.toHaveBeenCalled();
    expect(await service.resumeOwned(10)).toMatchObject({
      state: 'resumed',
      project: { revision: opened.data.revision, exportRecords: opened.data.exportRecords },
    });
  });

  it('records worker failure without creating a succeeded export', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'nw-main-export-fail-'));
    roots.push(parent);
    const target = path.join(parent, 'project');
    await cp(path.resolve('tests/fixtures/projects/linear'), target, { recursive: true });
    const service = new ProjectService(
      {
        chooseNewProject: async () => undefined,
        chooseExistingProject: async () => target,
        chooseMinutesFile: async () => undefined,
        chooseExportPath: async () => path.join(parent, 'failed.docx'),
      },
      runtime,
      undefined,
      new SerialLinearizationGate(),
      undefined,
      {
        generate: vi.fn(async () => {
          throw new Error('secret worker detail');
        }),
        shutdown: vi.fn(async () => undefined),
      },
    );
    const opened = await service.openWithDialog(10);
    if (opened.cancelled || 'recoveryRequired' in opened) throw new Error('unexpected open result');
    await expect(
      service.exportDocumentWithDialog(
        {
          sessionId: opened.data.sessionId,
          expectedRevision: opened.data.revision,
          versionId: opened.data.versions[0]!.id,
        },
        10,
      ),
    ).rejects.toMatchObject({ safe: { code: 'EXPORT_IO_ERROR' } });
    const resumed = await service.resumeOwned(10);
    expect(resumed).toMatchObject({ state: 'resumed' });
    if (resumed.state === 'resumed') {
      expect(resumed.project.exportRecords.at(-1)).toMatchObject({ status: 'failed' });
      expect(
        resumed.project.exportRecords.some(
          (record) => record.status === 'succeeded' && record.fileName === 'failed.docx',
        ),
      ).toBe(false);
      expect(JSON.stringify(resumed.project.exportRecords)).not.toContain('secret worker detail');
    }
  });
  it.each([
    ['afterPrepare', false],
    ['afterHeadReplace', true],
  ] as const)('reconciles export commit failure at %s', async (barrierName, committed) => {
    const parent = await mkdtemp(path.join(os.tmpdir(), `nw-main-export-${barrierName}-`));
    roots.push(parent);
    const target = path.join(parent, 'project');
    await cp(path.resolve('tests/fixtures/projects/linear'), target, { recursive: true });
    const output = path.join(parent, 'published.docx');
    const service = new ProjectService(
      {
        chooseNewProject: async () => undefined,
        chooseExistingProject: async () => target,
        chooseMinutesFile: async () => undefined,
        chooseExportPath: async () => output,
      },
      runtime,
      undefined,
      new SerialLinearizationGate(),
      undefined,
      {
        generate: vi.fn(async () => new Uint8Array([80, 75, 3, 4, 7])),
        shutdown: vi.fn(async () => undefined),
      },
    );
    const opened = await service.openWithDialog(10);
    if (opened.cancelled || 'recoveryRequired' in opened) throw new Error('unexpected open result');
    const initialSucceeded = opened.data.exportRecords.filter(
      (record) => record.status === 'succeeded',
    ).length;
    const initialFailed = opened.data.exportRecords.filter(
      (record) => record.status === 'failed',
    ).length;
    let injected = false;
    setCommitBarrierForTest((barrier) => {
      if (!injected && barrier === barrierName) {
        injected = true;
        throw new Error(`synthetic ${barrierName}`);
      }
    });
    const operation = service.exportDocumentWithDialog(
      {
        sessionId: opened.data.sessionId,
        expectedRevision: opened.data.revision,
        versionId: opened.data.versions[0]!.id,
      },
      10,
    );
    if (committed) {
      const result = await operation;
      expect(result.cancelled).toBe(false);
      if (!result.cancelled && !result.needsInput) expect(result.record.status).toBe('succeeded');
    } else {
      await expect(operation).rejects.toMatchObject({ safe: { code: 'EXPORT_IO_ERROR' } });
    }
    expect(await readFile(output)).toEqual(Buffer.from([80, 75, 3, 4, 7]));
    const resumed = await service.resumeOwned(10);
    if (resumed.state !== 'resumed') throw new Error('expected resumed project');
    expect(
      resumed.project.exportRecords.filter((record) => record.status === 'succeeded'),
    ).toHaveLength(initialSucceeded + (committed ? 1 : 0));
    expect(
      resumed.project.exportRecords.filter((record) => record.status === 'failed'),
    ).toHaveLength(initialFailed);
    setCommitBarrierForTest();
  });

  it.each(['mismatched-record', 'refresh-failure'] as const)(
    'does not reconcile a post-head export with %s',
    async (mode) => {
      const parent = await mkdtemp(path.join(os.tmpdir(), `nw-main-export-${mode}-`));
      roots.push(parent);
      const target = path.join(parent, 'project');
      await cp(path.resolve('tests/fixtures/projects/linear'), target, { recursive: true });
      const output = path.join(parent, 'published.docx');
      const service = new ProjectService(
        {
          chooseNewProject: async () => undefined,
          chooseExistingProject: async () => target,
          chooseMinutesFile: async () => undefined,
          chooseExportPath: async () => output,
        },
        runtime,
        undefined,
        new SerialLinearizationGate(),
        undefined,
        {
          generate: vi.fn(async () => new Uint8Array([80, 75, 3, 4, 6])),
          shutdown: vi.fn(async () => undefined),
        },
      );
      const opened = await service.openWithDialog(10);
      if (opened.cancelled || 'recoveryRequired' in opened)
        throw new Error('unexpected open result');
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Saved before the fault spy is installed.
      const originalRefresh = ProjectSession.prototype.refresh;
      vi.spyOn(ProjectSession.prototype, 'refresh').mockImplementation(async function (
        this: ProjectSession,
      ) {
        if (mode === 'refresh-failure') throw new Error('synthetic refresh failure');
        const authoritative = await originalRefresh.call(this);
        const newest = authoritative.exportRecords.at(-1);
        if (newest === undefined) throw new Error('expected committed export record');
        return {
          ...authoritative,
          exportRecords: authoritative.exportRecords.map((record) =>
            record.id === newest.id ? { ...record, fileName: 'mismatched.docx' } : record,
          ),
        };
      });
      setCommitBarrierForTest((barrier) => {
        if (barrier === 'afterHeadReplace') throw new Error('synthetic lost response');
      });
      await expect(
        service.exportDocumentWithDialog(
          {
            sessionId: opened.data.sessionId,
            expectedRevision: opened.data.revision,
            versionId: opened.data.versions[0]!.id,
          },
          10,
        ),
      ).rejects.toMatchObject({ safe: { code: 'EXPORT_IO_ERROR' } });
      expect(await readFile(output)).toEqual(Buffer.from([80, 75, 3, 4, 6]));
    },
  );

  it('preserves the original export failure when failed-record commit also fails', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'nw-main-export-double-fail-'));
    roots.push(parent);
    const target = path.join(parent, 'project');
    await cp(path.resolve('tests/fixtures/projects/linear'), target, { recursive: true });
    const service = new ProjectService(
      {
        chooseNewProject: async () => undefined,
        chooseExistingProject: async () => target,
        chooseMinutesFile: async () => undefined,
        chooseExportPath: async () => path.join(parent, 'never.docx'),
      },
      runtime,
      undefined,
      new SerialLinearizationGate(),
      undefined,
      {
        generate: vi.fn(async () => {
          throw new Error('worker private');
        }),
        shutdown: vi.fn(async () => undefined),
      },
    );
    const opened = await service.openWithDialog(10);
    if (opened.cancelled || 'recoveryRequired' in opened) throw new Error('unexpected open result');
    setCommitBarrierForTest((barrier) => {
      if (barrier === 'afterPrepare') throw new Error('failed record commit private');
    });
    await expect(
      service.exportDocumentWithDialog(
        {
          sessionId: opened.data.sessionId,
          expectedRevision: opened.data.revision,
          versionId: opened.data.versions[0]!.id,
        },
        10,
      ),
    ).rejects.toMatchObject({
      safe: { code: 'EXPORT_IO_ERROR', safeMessage: 'The document export could not be completed' },
    });
    setCommitBarrierForTest();
  });
  it('projects a newly created project through the strict renderer DTO schema', async () => {
    const { view } = await setup();
    expect(projectViewDtoSchema.parse(view)).toEqual(view);
  });
  it('resumes exactly one live session owned by the requesting renderer', async () => {
    const { service, view } = await setup();

    await expect(service.resumeOwned(11)).resolves.toEqual({ state: 'none' });
    await expect(service.resumeOwned(10)).resolves.toMatchObject({
      state: 'resumed',
      project: { sessionId: view.sessionId, revision: view.revision },
    });

    await service.close({ sessionId: view.sessionId, expectedRevision: view.revision }, 10);
    await expect(service.resumeOwned(10)).resolves.toEqual({ state: 'none' });
  });
  it('rejects ambiguous owner-session resume without disclosing a project', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'nw-main-resume-'));
    roots.push(parent);
    let nextTarget = 0;
    const service = new ProjectService(
      {
        chooseNewProject: async () => path.join(parent, `project-${++nextTarget}`),
        chooseExistingProject: async () => undefined,
        chooseMinutesFile: async () => undefined,
      },
      runtime,
    );
    const first = await service.createWithDialog(
      { name: 'first', profile: 'official', initialMinutes: '' },
      10,
    );
    const second = await service.createWithDialog(
      { name: 'second', profile: 'official', initialMinutes: '' },
      10,
    );
    if (first.cancelled || second.cancelled) throw new Error('unexpected cancellation');

    await expect(service.resumeOwned(10)).rejects.toMatchObject({
      safe: { code: 'PROJECT_STATE_CONFLICT' },
    });
    await expect(service.resumeOwned(11)).resolves.toEqual({ state: 'none' });
    await service.closeAll();
  });
  it('requires an owner-bound one-use confirmation before recovering and opening a stale lock', async () => {
    const { service, target, observedInstanceId } = await setupStaleLock();
    const pending = await service.openWithDialog(10);
    if (pending.cancelled || !('recoveryRequired' in pending))
      throw new Error('expected lock recovery');
    expect(pending.recoveryRequired.observedInstanceId).toBe(observedInstanceId);
    expect(JSON.stringify(pending)).not.toContain(target);

    const opened = await service.recoverOpen(
      { recoveryToken: pending.recoveryRequired.recoveryToken, confirmed: true },
      10,
    );
    expect(opened.name).toBe('合成项目');
    await expect(
      service.recoverOpen(
        { recoveryToken: pending.recoveryRequired.recoveryToken, confirmed: true },
        10,
      ),
    ).rejects.toMatchObject({ safe: { code: 'IPC_SENDER_REJECTED' } });
    await service.close({ sessionId: opened.sessionId, expectedRevision: opened.revision }, 10);
  });

  it('rejects forged and cross-owner recovery tokens without consuming the valid token', async () => {
    const { service } = await setupStaleLock();
    const pending = await service.openWithDialog(10);
    if (pending.cancelled || !('recoveryRequired' in pending))
      throw new Error('expected lock recovery');
    const recoveryToken = pending.recoveryRequired.recoveryToken;
    await expect(service.recoverOpen({ recoveryToken, confirmed: true }, 11)).rejects.toMatchObject(
      { safe: { code: 'IPC_SENDER_REJECTED' } },
    );
    await expect(
      service.recoverOpen(
        {
          recoveryToken: randomUUID() as typeof recoveryToken,
          confirmed: true,
        },
        10,
      ),
    ).rejects.toMatchObject({ safe: { code: 'IPC_SENDER_REJECTED' } });
    const opened = await service.recoverOpen({ recoveryToken, confirmed: true }, 10);
    await service.close({ sessionId: opened.sessionId, expectedRevision: opened.revision }, 10);
  });

  it('invalidates recovery confirmation on retry, expiry, owner disposal, and lock identity change', async () => {
    const retryCase = await setupStaleLock();
    const first = await retryCase.service.openWithDialog(10);
    if (first.cancelled || !('recoveryRequired' in first)) throw new Error('expected recovery');
    const second = await retryCase.service.openWithDialog(10);
    if (second.cancelled || !('recoveryRequired' in second)) throw new Error('expected recovery');
    await expect(
      retryCase.service.recoverOpen(
        { recoveryToken: first.recoveryRequired.recoveryToken, confirmed: true },
        10,
      ),
    ).rejects.toMatchObject({ safe: { code: 'IPC_SENDER_REJECTED' } });
    retryCase.service.discardPendingRecoveries(10);
    await expect(
      retryCase.service.recoverOpen(
        { recoveryToken: second.recoveryRequired.recoveryToken, confirmed: true },
        10,
      ),
    ).rejects.toMatchObject({ safe: { code: 'IPC_SENDER_REJECTED' } });

    const changedCase = await setupStaleLock();
    const changed = await changedCase.service.openWithDialog(20);
    if (changed.cancelled || !('recoveryRequired' in changed)) throw new Error('expected recovery');
    await rm(path.join(changedCase.target, '.news-writer', 'write.lock'), {
      recursive: true,
      force: true,
    });
    await writeStaleLock(changedCase.target);
    await expect(
      changedCase.service.recoverOpen(
        { recoveryToken: changed.recoveryRequired.recoveryToken, confirmed: true },
        20,
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_LOCKED' });
    await expect(
      changedCase.service.recoverOpen(
        { recoveryToken: changed.recoveryRequired.recoveryToken, confirmed: true },
        20,
      ),
    ).rejects.toMatchObject({ safe: { code: 'IPC_SENDER_REJECTED' } });

    vi.useFakeTimers();
    try {
      const expiredCase = await setupStaleLock();
      const expired = await expiredCase.service.openWithDialog(30);
      if (expired.cancelled || !('recoveryRequired' in expired))
        throw new Error('expected recovery');
      await vi.advanceTimersByTimeAsync(2 * 60 * 1_000);
      await expect(
        expiredCase.service.recoverOpen(
          { recoveryToken: expired.recoveryRequired.recoveryToken, confirmed: true },
          30,
        ),
      ).rejects.toMatchObject({ safe: { code: 'IPC_SENDER_REJECTED' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows only one of two concurrent confirmations to recover and open the project', async () => {
    const { service } = await setupStaleLock();
    const pending = await service.openWithDialog(10);
    if (pending.cancelled || !('recoveryRequired' in pending))
      throw new Error('expected lock recovery');
    const input = {
      recoveryToken: pending.recoveryRequired.recoveryToken,
      confirmed: true,
    } as const;
    const results = await Promise.allSettled([
      service.recoverOpen(input, 10),
      service.recoverOpen(input, 10),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const opened = results.find((result) => result.status === 'fulfilled');
    if (opened?.status !== 'fulfilled') throw new Error('expected successful recovery');
    await service.close(
      { sessionId: opened.value.sessionId, expectedRevision: opened.value.revision },
      10,
    );
  });

  it('uses opaque owner capabilities and optimistic revisions for mutations', async () => {
    const { service, view } = await setup();
    expect(view.minutes.content).toBe('活动纪要。');
    let rejected: unknown;
    try {
      service.refresh({ sessionId: view.sessionId, expectedRevision: 0 }, 11);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toMatchObject({ safe: { code: 'IPC_SENDER_REJECTED' } });
    const saved = await service.saveMinutes(
      { sessionId: view.sessionId, expectedRevision: 0, content: '更新后的活动纪要。' },
      10,
    );
    expect(saved.revision).toBe(1);
    expect(saved.minutes.content).toBe('更新后的活动纪要。');
    await expect(
      service.updateConfig(
        { sessionId: view.sessionId, expectedRevision: 0, config: { maxWords: 800 } },
        10,
      ),
    ).rejects.toMatchObject({ safe: { code: 'PROJECT_CONFLICT' } });
    await expect(
      service.close({ sessionId: view.sessionId, expectedRevision: 0 }, 10),
    ).rejects.toMatchObject({ safe: { code: 'PROJECT_CONFLICT' } });
    await expect(
      service.close({ sessionId: view.sessionId, expectedRevision: 1 }, 10),
    ).resolves.toEqual({ closed: true });
  });

  it('reuses an existing same-root session without retaining a second lock reference', async () => {
    const { service, view } = await setup();
    const reopened = await service.openWithDialog(10);
    expect(reopened).toEqual({ cancelled: false, data: view });
    await service.close({ sessionId: view.sessionId, expectedRevision: 0 }, 10);
  });

  it('rejects imported minutes over 1 MiB with a fixed safe error', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'nw-main-import-'));
    roots.push(parent);
    const minutesFile = path.join(parent, 'private-minutes.txt');
    const privateContent = 'private-minutes-content';
    await writeFile(minutesFile, Buffer.alloc(1_000_001, 0x61));
    const { service, view } = await setup(minutesFile);

    let error: unknown;
    try {
      await service.importMinutesWithDialog(
        { sessionId: view.sessionId, expectedRevision: view.revision },
        10,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      safe: {
        code: 'CONTENT_INVALID',
        safeMessage: 'The imported minutes file is invalid or could not be read',
      },
    });
    if (!(error instanceof SafeMainError)) throw new Error('expected safe main error');
    expect(JSON.stringify(error.safe)).not.toContain(minutesFile);
    expect(JSON.stringify(error.safe)).not.toContain(privateContent);
    expect(
      service.refresh({ sessionId: view.sessionId, expectedRevision: view.revision }, 10),
    ).toEqual(view);
  });

  it.each(['name', 'initialMinutes'] as const)(
    'rejects the configured exact key in project creation %s before creating files',
    async (field) => {
      const parent = await mkdtemp(path.join(os.tmpdir(), 'nw-main-secret-create-'));
      roots.push(parent);
      const target = path.join(parent, 'project');
      const key = 'synthetic-credential';
      const service = new ProjectService(
        {
          chooseNewProject: async () => target,
          chooseExistingProject: async () => undefined,
          chooseMinutesFile: async () => undefined,
        },
        {
          appVersion: '0.1.0',
          electronVersion: '43.3.0',
          chromiumVersion: '150.0.0',
        },
        { readConfiguredApiKey: async () => key },
      );
      await expect(
        service.createWithDialog(
          {
            name: field === 'name' ? `project ${key}` : 'safe project',
            profile: 'official',
            initialMinutes: field === 'initialMinutes' ? `minutes ${key}` : 'safe minutes',
          },
          10,
        ),
      ).rejects.toMatchObject({
        safe: {
          code: 'CONTENT_INVALID',
          safeMessage: 'Credential material cannot be stored in a project',
        },
      });
      await expect(writeFile(path.join(target, 'probe'), 'x')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('rejects the configured exact key across save, import, comment, and config mutations', async () => {
    const key = 'synthetic-credential';
    const parent = await mkdtemp(path.join(os.tmpdir(), 'nw-main-secret-import-'));
    roots.push(parent);
    const minutesFile = path.join(parent, 'minutes.txt');
    await writeFile(minutesFile, `import ${key}`, 'utf8');
    const { service, view } = await setupWithCredential(key, minutesFile);
    const attempts = [
      () =>
        service.saveMinutes(
          { sessionId: view.sessionId, expectedRevision: 0, content: `save ${key}` },
          10,
        ),
      () => service.importMinutesWithDialog({ sessionId: view.sessionId, expectedRevision: 0 }, 10),
      () =>
        service.updateConfig(
          {
            sessionId: view.sessionId,
            expectedRevision: 0,
            config: { targetChannel: `channel ${key}` },
          },
          10,
        ),
      () =>
        service.addComment(
          {
            sessionId: view.sessionId,
            expectedRevision: 0,
            versionId: versionIdSchema.parse(randomUUID()),
            anchor: {
              kind: 'textQuote' as const,
              contentSha256: '0'.repeat(64),
              start: 0,
              end: 1,
              exact: 'x',
              prefix: '',
              suffix: '',
            },
            quotedText: 'x',
            body: `comment ${key}`,
          },
          10,
        ),
    ];
    for (const attempt of attempts) {
      let error: unknown;
      try {
        await attempt();
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ safe: { code: 'CONTENT_INVALID' } });
      expect(JSON.stringify(error)).not.toContain(key);
      const aggregate = service.getOwned(view.sessionId, 10).aggregate;
      expect(aggregate.revision).toBe(0);
      expect(aggregate.comments).toHaveLength(0);
    }
    await service.close({ sessionId: view.sessionId, expectedRevision: 0 }, 10);
  });

  it('does not save a candidate key already present in an open project', async () => {
    const key = 'synthetic-credential';
    const { service, view } = await setup();
    const contaminated = await service.saveMinutes(
      { sessionId: view.sessionId, expectedRevision: 0, content: `minutes ${key}` },
      10,
    );
    let saved = false;
    await expect(
      service.setCredentialIfProjectsSafe(key, async () => {
        saved = true;
        return true;
      }),
    ).rejects.toMatchObject({ safe: { code: 'CONTENT_INVALID' } });
    expect(saved).toBe(false);
    expect(service.getOwned(view.sessionId, 10).aggregate.revision).toBe(contaminated.revision);
    await service.close({ sessionId: view.sessionId, expectedRevision: contaminated.revision }, 10);
  });

  it('closes and rejects an existing project containing the configured exact key before exposure', async () => {
    const key = 'synthetic-credential';
    const { service, view, target } = await setup();
    const contaminated = await service.saveMinutes(
      { sessionId: view.sessionId, expectedRevision: 0, content: `minutes ${key}` },
      10,
    );
    await service.close({ sessionId: view.sessionId, expectedRevision: contaminated.revision }, 10);
    const guarded = new ProjectService(
      {
        chooseNewProject: async () => undefined,
        chooseExistingProject: async () => target,
        chooseMinutesFile: async () => undefined,
      },
      {
        appVersion: '0.1.0',
        electronVersion: '43.3.0',
        chromiumVersion: '150.0.0',
      },
      { readConfiguredApiKey: async () => key },
    );
    let error: unknown;
    try {
      await guarded.openWithDialog(10);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ safe: { code: 'CONTENT_INVALID' } });
    expect(JSON.stringify(error)).not.toContain(key);
    expect(JSON.stringify(error)).not.toContain(target);

    const unguarded = new ProjectService(
      {
        chooseNewProject: async () => undefined,
        chooseExistingProject: async () => target,
        chooseMinutesFile: async () => undefined,
      },
      {
        appVersion: '0.1.0',
        electronVersion: '43.3.0',
        chromiumVersion: '150.0.0',
      },
    );
    const opened = await unguarded.openWithDialog(10);
    if (opened.cancelled || 'recoveryRequired' in opened)
      throw new Error('unexpected cancellation');
    expect(opened.data.minutes.content).toContain(key);
    await unguarded.close(
      { sessionId: opened.data.sessionId, expectedRevision: opened.data.revision },
      10,
    );
  });

  it('linearizes a project mutation before a competing credential replacement', async () => {
    const key = 'synthetic-credential';
    let configuredKey: string | undefined;
    const gate = new SerialLinearizationGate();
    const parent = await mkdtemp(path.join(os.tmpdir(), 'nw-main-linear-mutation-'));
    roots.push(parent);
    const target = path.join(parent, 'project');
    const service = new ProjectService(
      {
        chooseNewProject: async () => target,
        chooseExistingProject: async () => target,
        chooseMinutesFile: async () => undefined,
      },
      {
        appVersion: '0.1.0',
        electronVersion: '43.3.0',
        chromiumVersion: '150.0.0',
      },
      { readConfiguredApiKey: async () => configuredKey },
      gate,
    );
    const created = await service.createWithDialog(
      { name: 'linear project', profile: 'official', initialMinutes: 'safe minutes' },
      10,
    );
    if (created.cancelled) throw new Error('unexpected cancellation');
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let resolveBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      resolveBlocked = resolve;
    });
    setCommitBarrierForTest(async (barrier) => {
      if (barrier === 'afterPrepare') {
        resolveBlocked();
        await commitGate;
      }
    });
    const mutation = service.saveMinutes(
      {
        sessionId: created.data.sessionId,
        expectedRevision: 0,
        content: `minutes ${key}`,
      },
      10,
    );
    await blocked;
    let authWrites = 0;
    const setKey = service.setCredentialIfProjectsSafe(key, async () => {
      authWrites += 1;
      configuredKey = key;
      return true;
    });
    releaseCommit();
    const saved = await mutation;
    await expect(setKey).rejects.toMatchObject({ safe: { code: 'CONTENT_INVALID' } });
    expect(saved.revision).toBe(1);
    expect(authWrites).toBe(0);
    expect(configuredKey).toBeUndefined();
    setCommitBarrierForTest();
    await service.close({ sessionId: saved.sessionId, expectedRevision: saved.revision }, 10);
  });

  it('refreshes a post-head mutation before a queued candidate-key scan', async () => {
    const key = 'candidate-credential';
    let configuredKey: string | undefined = 'old-credential';
    const gate = new SerialLinearizationGate();
    const parent = await mkdtemp(path.join(os.tmpdir(), 'nw-main-post-head-mutation-'));
    roots.push(parent);
    const target = path.join(parent, 'project');
    const service = new ProjectService(
      {
        chooseNewProject: async () => target,
        chooseExistingProject: async () => target,
        chooseMinutesFile: async () => undefined,
      },
      {
        appVersion: '0.1.0',
        electronVersion: '43.3.0',
        chromiumVersion: '150.0.0',
      },
      { readConfiguredApiKey: async () => configuredKey },
      gate,
    );
    const created = await service.createWithDialog(
      { name: 'post head project', profile: 'official', initialMinutes: 'safe minutes' },
      10,
    );
    if (created.cancelled) throw new Error('unexpected cancellation');
    let releaseHead!: () => void;
    const headGate = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    let resolveAtHead!: () => void;
    const atHead = new Promise<void>((resolve) => {
      resolveAtHead = resolve;
    });
    let injected = false;
    setCommitBarrierForTest(async (barrier) => {
      if (!injected && barrier === 'afterHeadReplace') {
        injected = true;
        resolveAtHead();
        await headGate;
        throw new Error('synthetic post-head mutation response loss');
      }
    });
    const mutation = service.saveMinutes(
      {
        sessionId: created.data.sessionId,
        expectedRevision: created.data.revision,
        content: `minutes ${key}`,
      },
      10,
    );
    await atHead;
    let authWrites = 0;
    const setKey = service.setCredentialIfProjectsSafe(key, async () => {
      authWrites += 1;
      configuredKey = key;
      return true;
    });
    releaseHead();
    await expect(mutation).rejects.toThrow('project head requires recovery');
    await expect(setKey).rejects.toMatchObject({ safe: { code: 'CONTENT_INVALID' } });
    const aggregate = service.getOwned(created.data.sessionId, 10).aggregate;
    expect(aggregate.revision).toBe(1);
    expect(service.view(created.data.sessionId, 10).minutes.content).toContain(key);
    expect(authWrites).toBe(0);
    expect(configuredKey).toBe('old-credential');
    setCommitBarrierForTest();
    await service.close(
      { sessionId: created.data.sessionId, expectedRevision: aggregate.revision },
      10,
    );
  });

  it('does not persist a candidate key when authoritative session refresh fails', async () => {
    const key = 'candidate-credential';
    const { service, view } = await setup();
    await service.getOwned(view.sessionId, 10).project.close();
    let authWrites = 0;
    await expect(
      service.setCredentialIfProjectsSafe(key, async () => {
        authWrites += 1;
        return true;
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_LOCK_COMPROMISED' });
    expect(authWrites).toBe(0);
  });

  it('linearizes credential persistence before a competing mutation and create', async () => {
    const key = 'synthetic-credential';
    let configuredKey: string | undefined;
    const gate = new SerialLinearizationGate();
    const parent = await mkdtemp(path.join(os.tmpdir(), 'nw-main-linear-create-'));
    roots.push(parent);
    const existingTarget = path.join(parent, 'existing-project');
    const target = path.join(parent, 'created-project');
    const guarded = new ProjectService(
      {
        chooseNewProject: async () => existingTarget,
        chooseExistingProject: async () => undefined,
        chooseMinutesFile: async () => undefined,
      },
      {
        appVersion: '0.1.0',
        electronVersion: '43.3.0',
        chromiumVersion: '150.0.0',
      },
      { readConfiguredApiKey: async () => configuredKey },
      gate,
    );
    const existing = await guarded.createWithDialog(
      { name: 'existing project', profile: 'official', initialMinutes: 'safe minutes' },
      10,
    );
    if (existing.cancelled) throw new Error('unexpected cancellation');
    const creator = new ProjectService(
      {
        chooseNewProject: async () => target,
        chooseExistingProject: async () => undefined,
        chooseMinutesFile: async () => undefined,
      },
      {
        appVersion: '0.1.0',
        electronVersion: '43.3.0',
        chromiumVersion: '150.0.0',
      },
      { readConfiguredApiKey: async () => configuredKey },
      gate,
    );
    let releasePersist!: () => void;
    const persistGate = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    let resolvePersisting!: () => void;
    const persisting = new Promise<void>((resolve) => {
      resolvePersisting = resolve;
    });
    const setKey = guarded.setCredentialIfProjectsSafe(key, async () => {
      resolvePersisting();
      await persistGate;
      configuredKey = key;
      return true;
    });
    await persisting;
    const mutation = guarded.saveMinutes(
      {
        sessionId: existing.data.sessionId,
        expectedRevision: existing.data.revision,
        content: `minutes ${key}`,
      },
      10,
    );
    const create = creator.createWithDialog(
      { name: 'new project', profile: 'official', initialMinutes: `minutes ${key}` },
      10,
    );
    releasePersist();
    await expect(setKey).resolves.toBe(true);
    await expect(mutation).rejects.toMatchObject({ safe: { code: 'CONTENT_INVALID' } });
    await expect(create).rejects.toMatchObject({ safe: { code: 'CONTENT_INVALID' } });
    await expect(writeFile(path.join(target, 'probe'), 'x')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(guarded.getOwned(existing.data.sessionId, 10).aggregate.revision).toBe(0);
    await guarded.close(
      { sessionId: existing.data.sessionId, expectedRevision: existing.data.revision },
      10,
    );
  });

  it('linearizes open/register before candidate scan and preserves the close/open boundary', async () => {
    const key = 'synthetic-credential';
    const seeded = await setup();
    const contaminated = await seeded.service.saveMinutes(
      {
        sessionId: seeded.view.sessionId,
        expectedRevision: 0,
        content: `minutes ${key}`,
      },
      10,
    );
    await seeded.service.close(
      { sessionId: contaminated.sessionId, expectedRevision: contaminated.revision },
      10,
    );
    const gate = new SerialLinearizationGate();
    let configuredKey: string | undefined;
    let blockRead = true;
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let resolveReading!: () => void;
    const reading = new Promise<void>((resolve) => {
      resolveReading = resolve;
    });
    const service = new ProjectService(
      {
        chooseNewProject: async () => undefined,
        chooseExistingProject: async () => seeded.target,
        chooseMinutesFile: async () => undefined,
      },
      {
        appVersion: '0.1.0',
        electronVersion: '43.3.0',
        chromiumVersion: '150.0.0',
      },
      {
        readConfiguredApiKey: async () => {
          if (blockRead) {
            blockRead = false;
            resolveReading();
            await readGate;
          }
          return configuredKey;
        },
      },
      gate,
    );
    const opening = service.openWithDialog(10);
    await reading;
    let authWrites = 0;
    const setKey = service.setCredentialIfProjectsSafe(key, async () => {
      authWrites += 1;
      configuredKey = key;
      return true;
    });
    releaseRead();
    const opened = await opening;
    if (opened.cancelled || 'recoveryRequired' in opened)
      throw new Error('unexpected cancellation');
    await expect(setKey).rejects.toMatchObject({ safe: { code: 'CONTENT_INVALID' } });
    expect(authWrites).toBe(0);
    await service.close(
      { sessionId: opened.data.sessionId, expectedRevision: opened.data.revision },
      10,
    );
    const reopened = await service.openWithDialog(10);
    if (reopened.cancelled || 'recoveryRequired' in reopened)
      throw new Error('unexpected cancellation');
    expect(reopened.data.minutes.content).toContain(key);
    await service.close(
      { sessionId: reopened.data.sessionId, expectedRevision: reopened.data.revision },
      10,
    );
  });

  it.each(['queued', 'preparing', 'requesting', 'processing', 'saving'] as const)(
    'recovers a persisted %s task before exposing a reopened session',
    async (status) => {
      const { service, view, target } = await setup();
      const project = service.getOwned(view.sessionId, 10).project;
      const before = await persistActiveTask(project, status);
      await project.close();

      const reopenedService = new ProjectService(
        {
          chooseNewProject: async () => undefined,
          chooseExistingProject: async () => target,
          chooseMinutesFile: async () => undefined,
        },
        {
          appVersion: '0.1.0',
          electronVersion: '43.3.0',
          chromiumVersion: '150.0.0',
        },
      );
      const opened = await reopenedService.openWithDialog(10);
      if (opened.cancelled || 'recoveryRequired' in opened)
        throw new Error('unexpected cancellation');
      const recovered = reopenedService.getOwned(opened.data.sessionId, 10).aggregate;
      expect(recovered.revision).toBe(before.revision + 1);
      expect(recovered.tasks[0]).toMatchObject({
        status: 'failed',
        error: { code: 'TASK_INTERRUPTED' },
      });
      expect(recovered.versions).toHaveLength(0);
      await reopenedService.close(
        {
          sessionId: opened.data.sessionId,
          expectedRevision: recovered.revision,
        },
        10,
      );

      const secondService = new ProjectService(
        {
          chooseNewProject: async () => undefined,
          chooseExistingProject: async () => target,
          chooseMinutesFile: async () => undefined,
        },
        {
          appVersion: '0.1.0',
          electronVersion: '43.3.0',
          chromiumVersion: '150.0.0',
        },
      );
      const secondOpen = await secondService.openWithDialog(10);
      if (secondOpen.cancelled || 'recoveryRequired' in secondOpen)
        throw new Error('unexpected cancellation');
      expect(secondOpen.data.revision).toBe(recovered.revision);
      expect(secondOpen.data.tasks[0]?.status).toBe('failed');
      await secondService.close(
        {
          sessionId: secondOpen.data.sessionId,
          expectedRevision: secondOpen.data.revision,
        },
        10,
      );
    },
  );

  it('does not expose a session when interrupted-task recovery cannot commit', async () => {
    const { service, view, target } = await setup();
    const project = service.getOwned(view.sessionId, 10).project;
    await persistActiveTask(project, 'saving');
    await project.close();
    let injected = false;
    setCommitBarrierForTest((barrier) => {
      if (!injected && barrier === 'afterPrepare') {
        injected = true;
        throw new Error('synthetic recovery commit failure');
      }
    });
    const failingService = new ProjectService(
      {
        chooseNewProject: async () => undefined,
        chooseExistingProject: async () => target,
        chooseMinutesFile: async () => undefined,
      },
      {
        appVersion: '0.1.0',
        electronVersion: '43.3.0',
        chromiumVersion: '150.0.0',
      },
    );
    await expect(failingService.openWithDialog(10)).rejects.toThrow(
      'synthetic recovery commit failure',
    );
    expect(injected).toBe(true);
    setCommitBarrierForTest();

    const retry = await failingService.openWithDialog(10);
    if (retry.cancelled || 'recoveryRequired' in retry) throw new Error('unexpected cancellation');
    expect(retry.data.tasks[0]).toMatchObject({
      status: 'failed',
      error: { code: 'TASK_INTERRUPTED' },
    });
    await failingService.close(
      {
        sessionId: retry.data.sessionId,
        expectedRevision: retry.data.revision,
      },
      10,
    );
  });

  it('resolves an other publisher from trusted minutes and hard-blocks a missing publisher', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'nw-main-publisher-'));
    roots.push(parent);
    const create = async (name: string, initialMinutes: string) => {
      const target = path.join(parent, name);
      const service = new ProjectService(
        {
          chooseNewProject: async () => target,
          chooseExistingProject: async () => target,
          chooseMinutesFile: async () => undefined,
        },
        {
          appVersion: '0.1.0',
          electronVersion: '43.3.0',
          chromiumVersion: '150.0.0',
        },
      );
      const result = await service.createWithDialog({ name, profile: 'other', initialMinutes }, 10);
      if (result.cancelled) throw new Error('unexpected cancellation');
      return { service, view: result.data };
    };
    const valid = await create(
      'valid',
      '[主体]\n青禾实践队\n\n[活动内容]\n2099年1月1日，青禾实践队在A101开展活动。',
    );
    const prepared = await valid.service.preparePrompt(
      {
        sessionId: valid.view.sessionId,
        expectedRevision: valid.view.revision,
        kind: 'draftGeneration',
        parentVersionId: null,
      },
      10,
    );
    expect(prepared.messages[0].content).toContain('发布/落款主体：青禾实践队');
    await valid.service.closeAll();

    const invalid = await create('invalid', '2099年1月1日在A101开展活动。');
    await expect(
      invalid.service.preparePrompt(
        {
          sessionId: invalid.view.sessionId,
          expectedRevision: invalid.view.revision,
          kind: 'draftGeneration',
          parentVersionId: null,
        },
        10,
      ),
    ).rejects.toMatchObject({ safe: { code: 'PROJECT_STATE_CONFLICT' } });
    await invalid.service.closeAll();
  });

  it('keeps prepare side-effect free, including Prompt artifacts', async () => {
    const { service, view, target } = await setup();
    const before = structuredClone(service.getOwned(view.sessionId, 10).aggregate);
    await service.preparePrompt(
      {
        sessionId: view.sessionId,
        expectedRevision: view.revision,
        kind: 'draftGeneration',
        parentVersionId: null,
      },
      10,
    );
    expect(service.getOwned(view.sessionId, 10).aggregate).toEqual(before);
    const promptDirectory = path.join(target, 'content', 'prompts');
    const entries = await readdir(promptDirectory).catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
        return [];
      throw error;
    });
    expect(entries).toEqual([]);
    await service.closeAll();
  });

  it('applies user-config CAS through ProjectService and blocks credential material', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'nw-main-user-config-'));
    roots.push(parent);
    const target = path.join(parent, 'project');
    const userConfig = new UserConfigService(path.join(parent, 'user-data'));
    const key = 'configured-secret-value';
    const service = new ProjectService(
      {
        chooseNewProject: async () => target,
        chooseExistingProject: async () => target,
        chooseMinutesFile: async () => undefined,
      },
      {
        appVersion: '0.1.0',
        electronVersion: '43.3.0',
        chromiumVersion: '150.0.0',
      },
      { readConfiguredApiKey: async () => key },
      new SerialLinearizationGate(),
      userConfig,
    );
    await expect(
      service.updateUserConfig({ expectedRevision: 0, config: { targetChannel: key } }),
    ).rejects.toMatchObject({ safe: { code: 'CONTENT_INVALID' } });
    await expect(
      service.updateUserConfig({ expectedRevision: 0, config: { maxWords: 810 } }),
    ).resolves.toEqual({ revision: 1, config: { maxWords: 810 } });
    await expect(
      service.updateUserConfig({ expectedRevision: 0, config: { maxWords: 820 } }),
    ).rejects.toMatchObject({ safe: { code: 'PROJECT_CONFLICT' } });
  });

  it('linearizes user-config persistence with project mutations through the global gate', async () => {
    const gate = new SerialLinearizationGate();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const userConfig = {
      get: () => Promise.resolve({ revision: 0, config: {} }),
      update: async (_expectedRevision: number, config: { maxWords?: number }) => {
        entered();
        await held;
        return { revision: 1, config };
      },
    };
    const parent = await mkdtemp(path.join(os.tmpdir(), 'nw-main-user-gate-'));
    roots.push(parent);
    const target = path.join(parent, 'project');
    const service = new ProjectService(
      {
        chooseNewProject: async () => target,
        chooseExistingProject: async () => target,
        chooseMinutesFile: async () => undefined,
      },
      {
        appVersion: '0.1.0',
        electronVersion: '43.3.0',
        chromiumVersion: '150.0.0',
      },
      undefined,
      gate,
      userConfig,
    );
    const created = await service.createWithDialog(
      { name: 'gate', profile: 'official', initialMinutes: '纪要' },
      10,
    );
    if (created.cancelled) throw new Error('unexpected cancellation');
    const settings = service.updateUserConfig({ expectedRevision: 0, config: { maxWords: 800 } });
    await started;
    let mutationFinished = false;
    const mutation = service
      .saveMinutes(
        {
          sessionId: created.data.sessionId,
          expectedRevision: created.data.revision,
          content: '新纪要',
        },
        10,
      )
      .then((value) => {
        mutationFinished = true;
        return value;
      });
    await Promise.resolve();
    expect(mutationFinished).toBe(false);
    release();
    await expect(settings).resolves.toMatchObject({ revision: 1 });
    await expect(mutation).resolves.toMatchObject({ revision: 1 });
    await service.closeAll();
  });
});
