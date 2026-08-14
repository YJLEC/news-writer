import { randomUUID } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  commitSuccessfulVersion,
  createProject,
  queueTask,
  recordRetrieval,
  saveMinutes,
  transitionTask,
  updateProjectConfig,
  type ProjectAggregateV1,
} from '@news-writer/domain';
import {
  projectRelativePathSchema,
  retrievalReportIdSchema,
  timestampSchema,
  versionIdSchema,
  type Clock,
  type EntityKind,
  type IdGenerator,
  type TextArtifactRef,
} from '@news-writer/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { setCommitBarrierForTest, type CommitBarrier } from './faults';
import { ProjectLock } from './lock';
import { hydrateProjectState } from './layout';
import {
  createProjectOnDisk,
  diagnoseProject,
  makeCommitId,
  makeTransactionId,
  openProject,
  ProjectSession,
  recoverProjectLock,
} from './repository';
import { lockOwnerV1Schema, projectHeadV1Schema } from './schemas';
import { serializeJson, sha256 } from './serialization';

const roots: string[] = [];
const runtime = {
  appVersion: '0.1.0',
  electronVersion: '43.3.0',
  chromiumVersion: '150.0.0',
} as const;
const workerPath = path.resolve(
  import.meta.dirname,
  '../../../tests/helpers/project-process-worker.mjs',
);

const waitForMessage = async (child: ChildProcess): Promise<Record<string, unknown>> =>
  await new Promise((resolve, reject) => {
    child.once('message', (message) => resolve(message as Record<string, unknown>));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== null && code !== 0) reject(new Error(`Child exited before a message: ${code}`));
    });
  });

const waitForExit = async (child: ChildProcess): Promise<number | null> => {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
};

afterEach(async () => {
  setCommitBarrierForTest();
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

const uuid = (value: number): string =>
  `10000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

class FixedIds implements IdGenerator {
  #next = 1;

  next(kind: EntityKind): string {
    void kind;
    return uuid(this.#next++);
  }

  peek(offset = 0): string {
    return uuid(this.#next + offset);
  }
}

class FixedClock implements Clock {
  #next = 0;

  now() {
    this.#next += 1;
    return timestampSchema.parse(`2026-08-09T02:00:${this.#next.toString().padStart(2, '0')}.000Z`);
  }
}

const artifact = (relativePath: string, text: string): TextArtifactRef => {
  const bytes = Buffer.from(text, 'utf8');
  return {
    relativePath: projectRelativePathSchema.parse(relativePath),
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    mediaType: 'text/markdown',
    encoding: 'utf-8',
  };
};

const setup = async (name = '测试 项目') => {
  const parent = await mkdtemp(path.join(tmpdir(), 'news-writer-storage-'));
  roots.push(parent);
  const target = path.join(parent, name);
  const minutesText = '活动时间：2026年8月9日。\n';
  const minutesRef = artifact(`content/minutes/${uuid(2)}/${uuid(3)}.md`, minutesText);
  const clock = new FixedClock();
  const ids = new FixedIds();
  const aggregate = createProject(
    {
      name: '纯合成项目',
      profile: 'official',
      minutesContentRef: minutesRef,
      runtime,
    },
    { ids, clock },
  );
  const session = await createProjectOnDisk({
    root: target,
    appVersion: '0.1.0',
    aggregate,
    artifacts: new Map([[minutesRef.relativePath, minutesText]]),
    transactionId: uuid(900),
    commitId: uuid(901),
  });
  return { parent, target, session, aggregate, clock, ids, minutesRef };
};

const commitConfig = async (
  session: Awaited<ReturnType<typeof openProject>>,
  project: ProjectAggregateV1,
  clock: FixedClock,
  model: string,
  transactionId = makeTransactionId(),
  commitId = makeCommitId(),
) => {
  const next = updateProjectConfig(project, { model }, project.revision, clock.now(), runtime);
  return await session.commit({
    transactionId,
    commitId,
    expectedRevision: project.revision,
    expectedHeadCommitId: session.headCommitId,
    nextAggregate: next,
  });
};

const commitUpdate = async (
  session: Awaited<ReturnType<typeof openProject>>,
  current: ProjectAggregateV1,
  next: ProjectAggregateV1,
  artifacts: ReadonlyMap<string, string> = new Map(),
): Promise<ProjectAggregateV1> =>
  await session.commit({
    transactionId: makeTransactionId(),
    commitId: makeCommitId(),
    expectedRevision: current.revision,
    expectedHeadCommitId: session.headCommitId,
    nextAggregate: next,
    artifacts,
  });

const setupSavingTask = async (name: string) => {
  const initialized = await setup(name);
  const { session, aggregate, clock, ids } = initialized;
  const promptText = '请根据合成活动纪要生成测试新闻稿。';
  const promptRef = artifact(`content/prompts/${uuid(5)}/0.txt`, promptText);
  let current = aggregate;
  let next = queueTask(
    current,
    {
      kind: 'draftGeneration',
      messages: [{ role: 'user', contentRef: promptRef }],
      editedByUser: false,
      upstream: {
        promptInputFingerprint: promptRef.sha256,
        currentInputFingerprint: promptRef.sha256,
        staleResolution: 'current',
      },
      config: {
        defaults: {
          model: 'deepseek-chat',
          reasoningEffort: 'off',
          targetChannel: '学院网站',
          maxWords: 800,
          requestTimeoutMs: 60_000,
        },
      },
    },
    current.revision,
    { clock, ids, runtime },
  );
  current = await commitUpdate(
    session,
    current,
    next,
    new Map([[promptRef.relativePath, promptText]]),
  );
  const taskId = current.tasks[0]?.id;
  if (taskId === undefined) throw new Error('missing queued task');
  for (const status of ['preparing', 'requesting', 'processing'] as const) {
    next = transitionTask(current, taskId, { status }, current.revision, clock.now(), runtime);
    current = await commitUpdate(session, current, next);
  }
  const successTransactionId = makeTransactionId();
  const versionId = versionIdSchema.parse(ids.next('version'));
  next = transitionTask(
    current,
    taskId,
    {
      status: 'saving',
      successTransactionId,
      proposedVersionId: versionId,
    },
    current.revision,
    clock.now(),
    runtime,
  );
  current = await commitUpdate(session, current, next);
  await session.close();
  return { ...initialized, savingRevision: current.revision, taskId, versionId };
};

const setupCompletedTask = async (name: string) => {
  const initialized = await setupSavingTask(name);
  const session = await openProject({ root: initialized.target, appVersion: '0.1.0' });
  const current = session.read();
  const task = current.tasks.find((candidate) => candidate.id === initialized.taskId);
  if (task?.status !== 'saving') throw new Error('missing saving task');
  const versionText = '合成新闻稿正文，仅用于提交完整性测试。\n';
  const versionRef = artifact(`content/versions/${initialized.versionId}.md`, versionText);
  const next = commitSuccessfulVersion(
    current,
    { taskId: task.id, contentRef: versionRef, createdAt: initialized.clock.now() },
    current.revision,
    { readText: () => versionText },
    runtime,
  );
  const commitId = makeCommitId();
  const completed = await session.commit({
    transactionId: task.successTransactionId,
    commitId,
    expectedRevision: current.revision,
    expectedHeadCommitId: session.headCommitId,
    operation: 'completeTaskWithVersion',
    details: {
      operation: 'completeTaskWithVersion',
      successTransactionId: task.successTransactionId,
      taskId: task.id,
      fromTaskSequence: task.sequence,
      toTaskSequence: task.sequence + 1,
      versionId: initialized.versionId,
      baseRevision: current.revision,
      revision: current.revision + 1,
    },
    nextAggregate: next,
    artifacts: new Map([[versionRef.relativePath, versionText]]),
  });
  await session.close();
  return { ...initialized, commitId, completed };
};

const setupTwoCompletedTasks = async (name: string) => {
  const initialized = await setupCompletedTask(name);
  const session = await openProject({ root: initialized.target, appVersion: '0.1.0' });
  let current = session.read();
  const promptText = '请审校合成新闻稿。';
  const promptRef = artifact(`content/prompts/${initialized.ids.peek(1)}/0.txt`, promptText);
  let next = queueTask(
    current,
    {
      kind: 'aiReview',
      messages: [{ role: 'user', contentRef: promptRef }],
      editedByUser: false,
      upstream: {
        promptInputFingerprint: promptRef.sha256,
        currentInputFingerprint: promptRef.sha256,
        staleResolution: 'current',
      },
      config: {
        defaults: {
          model: 'deepseek-chat',
          reasoningEffort: 'off',
          targetChannel: '学院网站',
          maxWords: 800,
          requestTimeoutMs: 60_000,
        },
      },
    },
    current.revision,
    { clock: initialized.clock, ids: initialized.ids, runtime },
  );
  current = await commitUpdate(
    session,
    current,
    next,
    new Map([[promptRef.relativePath, promptText]]),
  );
  const task = current.tasks.at(-1);
  if (task === undefined) throw new Error('missing review task');
  for (const status of ['preparing', 'requesting', 'processing'] as const) {
    next = transitionTask(
      current,
      task.id,
      { status },
      current.revision,
      initialized.clock.now(),
      runtime,
    );
    current = await commitUpdate(session, current, next);
  }
  const versionId = versionIdSchema.parse(initialized.ids.next('version'));
  const successTransactionId = makeTransactionId();
  next = transitionTask(
    current,
    task.id,
    {
      status: 'saving',
      successTransactionId,
      proposedVersionId: versionId,
    },
    current.revision,
    initialized.clock.now(),
    runtime,
  );
  current = await commitUpdate(session, current, next);
  const savingTask = current.tasks.find((candidate) => candidate.id === task.id);
  if (savingTask?.status !== 'saving') throw new Error('missing saving review task');
  const versionText = '合成新闻稿审校版本，仅用于提交完整性测试。\n';
  const versionRef = artifact(`content/versions/${versionId}.md`, versionText);
  next = commitSuccessfulVersion(
    current,
    { taskId: task.id, contentRef: versionRef, createdAt: initialized.clock.now() },
    current.revision,
    { readText: () => versionText },
    runtime,
  );
  const commitId = makeCommitId();
  const completed = await session.commit({
    transactionId: successTransactionId,
    commitId,
    expectedRevision: current.revision,
    expectedHeadCommitId: session.headCommitId,
    operation: 'completeTaskWithVersion',
    details: {
      operation: 'completeTaskWithVersion',
      successTransactionId,
      taskId: task.id,
      fromTaskSequence: savingTask.sequence,
      toTaskSequence: savingTask.sequence + 1,
      versionId,
      baseRevision: current.revision,
      revision: current.revision + 1,
    },
    nextAggregate: next,
    artifacts: new Map([[versionRef.relativePath, versionText]]),
  });
  await session.close();
  return {
    ...initialized,
    commitId,
    completed,
    previousVersionId: initialized.versionId,
    versionId,
  };
};

const expireAndRecoverKilledLock = async (target: string): Promise<void> => {
  const lockRoot = path.join(target, '.news-writer', 'write.lock');
  const ownerPath = path.join(lockRoot, 'owner.json');
  const owner = lockOwnerV1Schema.parse(JSON.parse(await readFile(ownerPath, 'utf8')));
  const oldTimestamp = timestampSchema.parse('2000-01-01T00:00:00.000Z');
  await writeFile(ownerPath, serializeJson({ ...owner, heartbeatAt: oldTimestamp }));
  const old = new Date(oldTimestamp);
  await utimes(lockRoot, old, old);
  await recoverProjectLock(target, owner.instanceId, true);
};

const resignHeadState = async (
  target: string,
  nextState: ReturnType<typeof projectHeadV1Schema.parse>['state'],
  updateWrites: (writes: Array<Record<string, unknown>>) => Array<Record<string, unknown>> = (
    writes,
  ) => writes,
): Promise<void> => {
  const headTarget = path.join(target, 'project.json');
  const head = projectHeadV1Schema.parse(JSON.parse(await readFile(headTarget, 'utf8')));
  const snapshotTarget = path.join(target, ...head.snapshot.relativePath.split('/'));
  const snapshot = JSON.parse(await readFile(snapshotTarget, 'utf8')) as Record<string, unknown>;
  const snapshotBytes = serializeJson({ ...snapshot, state: nextState });
  await writeFile(snapshotTarget, snapshotBytes);
  const snapshotRef = {
    ...head.snapshot,
    sha256: sha256(snapshotBytes),
    byteLength: snapshotBytes.byteLength,
  };
  const commitTarget = path.join(
    target,
    '.news-writer',
    'commits',
    `${head.revision}-${head.headCommitId}.json`,
  );
  const manifest = JSON.parse(await readFile(commitTarget, 'utf8')) as Record<string, unknown> & {
    writes: Array<Record<string, unknown>>;
  };
  const commitBytes = serializeJson({
    ...manifest,
    snapshot: snapshotRef,
    writes: updateWrites(manifest.writes),
  });
  await writeFile(commitTarget, commitBytes);
  await writeFile(
    headTarget,
    serializeJson({
      ...head,
      headCommitHash: sha256(commitBytes),
      snapshot: snapshotRef,
      state: nextState,
    }),
  );
};

describe('project repository', () => {
  it('reads only aggregate-owned text refs and rejects forged metadata', async () => {
    const { session, minutesRef } = await setup('只读正文');
    expect(session.readText(minutesRef)).toContain('2026年8月9日');
    expect(() =>
      session.readText({
        ...minutesRef,
        mediaType: 'text/plain',
      }),
    ).toThrow(/not owned/i);
    expect(() =>
      session.readText({
        ...minutesRef,
        relativePath: projectRelativePathSchema.parse('content/minutes/forged.md'),
      }),
    ).toThrow(/not owned/i);
    await session.close();
  });

  it('creates, commits, closes, reopens, and preserves strict head state', async () => {
    const { target, session, aggregate, clock } = await setup();
    const committed = await commitConfig(session, aggregate, clock, 'deepseek-chat');
    expect(committed.revision).toBe(1);
    expect(committed.projectConfig.model).toBe('deepseek-chat');
    const head = projectHeadV1Schema.parse(
      JSON.parse(await readFile(path.join(target, 'project.json'), 'utf8')),
    );
    expect(head.revision).toBe(1);
    await session.close();
    const reopened = await openProject({ root: target, appVersion: '0.1.0' });
    expect(reopened.read()).toEqual(committed);
    await reopened.close();
  });

  it('reuses the same canonical session within one process', async () => {
    const { target, session } = await setup();
    const duplicate = await openProject({ root: target.toUpperCase(), appVersion: '0.1.0' });
    expect(duplicate).toBe(session);
    await duplicate.close();
    expect(session.read().revision).toBe(0);
    await session.close();
  });

  it('forwards a uniquely committed successor after a head-update crash', async () => {
    const { target, session, aggregate, clock } = await setup('恢复项目');
    const transactionId = makeTransactionId();
    const commitId = makeCommitId();
    setCommitBarrierForTest((barrier) => {
      if (barrier === 'afterCommitPublish') throw new Error('simulated crash');
    });
    await expect(
      commitConfig(session, aggregate, clock, 'recovery-model', transactionId, commitId),
    ).rejects.toMatchObject({ code: 'PROJECT_RECOVERY_REQUIRED', transactionId });
    setCommitBarrierForTest();
    await session.close();
    const reopened = await openProject({ root: target, appVersion: '0.1.0' });
    expect(reopened.read().revision).toBe(1);
    expect(reopened.read().projectConfig.model).toBe('recovery-model');
    await reopened.close();
  });

  it('does not register snapshot or record orphans created before the commit point', async () => {
    const { target, session, aggregate, clock } = await setup('孤儿项目');
    setCommitBarrierForTest((barrier) => {
      if (barrier === 'afterSnapshotPublish') throw new Error('before commit');
    });
    await expect(commitConfig(session, aggregate, clock, 'orphan-model')).rejects.toThrow(
      'before commit',
    );
    setCommitBarrierForTest();
    await session.close();
    const reopened = await openProject({ root: target, appVersion: '0.1.0' });
    expect(reopened.read().revision).toBe(0);
    expect(reopened.read().projectConfig.model).toBeUndefined();
    await reopened.close();
  });

  it.each([
    'afterStagingPayloads',
    'afterPrepare',
    'afterPayloadPublish',
    'afterSnapshotPublish',
  ] satisfies CommitBarrier[])('keeps the old head when interrupted at %s', async (crashPoint) => {
    const { target, session, aggregate, clock } = await setup(`提交前-${crashPoint}`);
    setCommitBarrierForTest((barrier) => {
      if (barrier === crashPoint) throw new Error(crashPoint);
    });
    await expect(commitConfig(session, aggregate, clock, crashPoint)).rejects.toThrow(crashPoint);
    setCommitBarrierForTest();
    await session.close();
    const reopened = await openProject({ root: target, appVersion: '0.1.0' });
    expect(reopened.read().revision).toBe(0);
    await reopened.close();
  });

  it('recognizes a committed head when interrupted before responding', async () => {
    const { target, session, aggregate, clock } = await setup('响应前项目');
    setCommitBarrierForTest((barrier) => {
      if (barrier === 'afterHeadReplace') throw new Error('response lost');
    });
    await expect(commitConfig(session, aggregate, clock, 'response-lost')).rejects.toMatchObject({
      code: 'PROJECT_RECOVERY_REQUIRED',
    });
    setCommitBarrierForTest();
    await session.close();
    const reopened = await openProject({ root: target, appVersion: '0.1.0' });
    expect(reopened.read().revision).toBe(1);
    expect(reopened.read().projectConfig.model).toBe('response-lost');
    await reopened.close();
  });

  it('remains portable when copied while closed and contains no absolute source root', async () => {
    const { parent, target, session } = await setup('可移植项目');
    const projectId = session.read().projectId;
    await session.close();
    const copied = path.join(parent, '复制 项目');
    await cp(target, copied, { recursive: true });
    const opened = await openProject({ root: copied, appVersion: '0.1.0' });
    expect(opened.read().projectId).toBe(projectId);
    await opened.close();

    const pending = [copied];
    while (pending.length > 0) {
      const directory = pending.pop();
      if (directory === undefined) break;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(candidate);
        else expect((await readFile(candidate)).toString('utf8')).not.toContain(target);
      }
    }
  });

  it('opens a closed project after copying it to a Chinese path longer than 260 characters', async () => {
    const { parent, target, session } = await setup('长路径源项目');
    await session.close();
    const longParent = path.join(
      parent,
      ...Array.from({ length: 6 }, (_, index) => `第${index}层-${'合成路径'.repeat(10)}`),
    );
    await mkdir(longParent, { recursive: true });
    const copied = path.join(longParent, '最终 项目');
    expect(copied.length).toBeGreaterThan(260);
    await cp(target, copied, { recursive: true });
    const opened = await openProject({ root: copied, appVersion: '0.1.0' });
    expect(opened.read().name).toBe('纯合成项目');
    await opened.close();
  });

  it('rejects a storage junction instead of following it', async () => {
    const { target, session } = await setup('链接项目');
    await session.close();
    const content = path.join(target, 'content');
    const relocated = path.join(target, 'content-relocated');
    await rename(content, relocated);
    await symlink(relocated, content, 'junction');
    await expect(openProject({ root: target, appVersion: '0.1.0' })).rejects.toMatchObject({
      code: 'PROJECT_PATH_ESCAPE',
    });
  });

  it('detects content corruption and refuses future storage versions without rewriting', async () => {
    const { target, session, minutesRef } = await setup('损坏项目');
    await session.close();
    await writeFile(path.join(target, ...minutesRef.relativePath.split('/')), 'tampered\n', 'utf8');
    await expect(diagnoseProject(target)).rejects.toMatchObject({ code: 'PROJECT_HASH_MISMATCH' });

    const future = await setup('未来项目');
    await future.session.close();
    const headTarget = path.join(future.target, 'project.json');
    const current = JSON.parse(await readFile(headTarget, 'utf8')) as Record<string, unknown>;
    const bytes = Buffer.from(`${JSON.stringify({ ...current, storageVersion: 2 })}\n`, 'utf8');
    await writeFile(headTarget, bytes);
    await expect(diagnoseProject(future.target)).rejects.toMatchObject({
      code: 'PROJECT_SCHEMA_TOO_NEW',
    });
    expect(await readFile(headTarget)).toEqual(bytes);

    const unsupportedOld = await setup('旧格式项目');
    await unsupportedOld.session.close();
    const oldHeadTarget = path.join(unsupportedOld.target, 'project.json');
    const oldCurrent = JSON.parse(await readFile(oldHeadTarget, 'utf8')) as Record<string, unknown>;
    const oldBytes = Buffer.from(
      `${JSON.stringify({ ...oldCurrent, storageVersion: 0 })}\n`,
      'utf8',
    );
    await writeFile(oldHeadTarget, oldBytes);
    await expect(diagnoseProject(unsupportedOld.target)).rejects.toMatchObject({
      code: 'PROJECT_SCHEMA_INVALID',
    });
    expect(await readFile(oldHeadTarget)).toEqual(oldBytes);
  });

  it('rejects an oversized record before parsing or hydrating it', async () => {
    const { target, session } = await setup('超限记录项目');
    await session.close();
    const head = projectHeadV1Schema.parse(
      JSON.parse(await readFile(path.join(target, 'project.json'), 'utf8')),
    );
    const recordTarget = path.join(target, ...head.state.currentMinutes.relativePath.split('/'));
    await writeFile(recordTarget, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    await expect(openProject({ root: target, appVersion: '0.1.0' })).rejects.toMatchObject({
      code: 'PROJECT_SCHEMA_INVALID',
    });
  });

  it('rejects a project when a historical commit write is missing', async () => {
    const { target } = await setupCompletedTask('历史写入缺失项目');
    const commitsRoot = path.join(target, '.news-writer', 'commits');
    let historicalTaskPath: string | undefined;
    for (const name of await readdir(commitsRoot)) {
      const commit = JSON.parse(await readFile(path.join(commitsRoot, name), 'utf8')) as {
        writes?: Array<{ kind?: string; relativePath?: string }>;
      };
      historicalTaskPath ??= commit.writes?.find(
        (write) => write.kind === 'task' && write.relativePath?.endsWith('/0.json'),
      )?.relativePath;
    }
    if (historicalTaskPath === undefined) throw new Error('missing historical task write');
    await rm(path.join(target, ...historicalTaskPath.split('/')));
    await expect(diagnoseProject(target)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('rejects completed-task details that do not match the committed snapshot', async () => {
    const { target, completed, commitId } = await setupCompletedTask('完成详情伪造项目');
    const commitTarget = path.join(
      target,
      '.news-writer',
      'commits',
      `${completed.revision}-${commitId}.json`,
    );
    const manifest = JSON.parse(await readFile(commitTarget, 'utf8')) as {
      details: Record<string, unknown>;
    };
    const commitBytes = serializeJson({
      ...manifest,
      details: { ...manifest.details, taskId: uuid(999) },
    });
    await writeFile(commitTarget, commitBytes);
    const headTarget = path.join(target, 'project.json');
    const head = projectHeadV1Schema.parse(JSON.parse(await readFile(headTarget, 'utf8')));
    await writeFile(headTarget, serializeJson({ ...head, headCommitHash: sha256(commitBytes) }));
    await expect(diagnoseProject(target)).rejects.toMatchObject({ code: 'PROJECT_SCHEMA_INVALID' });
  });

  it('rejects a re-signed completed task with the wrong committed revision', async () => {
    const { target, completed } = await setupCompletedTask('完成版本号伪造项目');
    const head = projectHeadV1Schema.parse(
      JSON.parse(await readFile(path.join(target, 'project.json'), 'utf8')),
    );
    const taskRef = head.state.tasks[0];
    if (taskRef === undefined) throw new Error('missing succeeded task record');
    const taskTarget = path.join(target, ...taskRef.relativePath.split('/'));
    const taskRecord = JSON.parse(await readFile(taskTarget, 'utf8')) as {
      payload: Record<string, unknown>;
    };
    const taskBytes = serializeJson({
      ...taskRecord,
      payload: { ...taskRecord.payload, committedRevision: completed.revision + 1 },
    });
    await writeFile(taskTarget, taskBytes);
    const nextTaskRef = {
      ...taskRef,
      sha256: sha256(taskBytes),
      byteLength: taskBytes.byteLength,
    };
    await resignHeadState(target, { ...head.state, tasks: [nextTaskRef] }, (writes) =>
      writes.map((write) =>
        write.relativePath === taskRef.relativePath ? { ...write, ...nextTaskRef } : write,
      ),
    );
    await expect(diagnoseProject(target)).rejects.toMatchObject({ code: 'PROJECT_SCHEMA_INVALID' });
  });

  it('rejects a re-signed completion snapshot that leaves an older version latest', async () => {
    const { target, previousVersionId } = await setupTwoCompletedTasks('完成最新版伪造项目');
    const head = projectHeadV1Schema.parse(
      JSON.parse(await readFile(path.join(target, 'project.json'), 'utf8')),
    );
    await resignHeadState(target, { ...head.state, latestVersionId: previousVersionId });
    await expect(diagnoseProject(target)).rejects.toMatchObject({ code: 'PROJECT_SCHEMA_INVALID' });
  });

  it('treats transaction retries as idempotent and stale new transactions as conflicts', async () => {
    const { session, aggregate, clock } = await setup('幂等项目');
    const transactionId = makeTransactionId();
    const commitId = makeCommitId();
    const committed = await commitConfig(
      session,
      aggregate,
      clock,
      'idempotent',
      transactionId,
      commitId,
    );
    const retried = await session.commit({
      transactionId,
      commitId,
      expectedRevision: aggregate.revision,
      expectedHeadCommitId: uuid(901),
      nextAggregate: committed,
    });
    expect(retried.revision).toBe(committed.revision);
    await expect(
      session.commit({
        transactionId: makeTransactionId(),
        commitId: makeCommitId(),
        expectedRevision: 0,
        expectedHeadCommitId: uuid(901),
        nextAggregate: updateProjectConfig(aggregate, { model: 'stale' }, 0, clock.now(), runtime),
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_CONFLICT' });
    await session.close();
  });

  it('rejects credential-shaped project metadata before publishing it', async () => {
    const { target, session, aggregate, clock } = await setup('凭据边界项目');
    const syntheticApiKey = ['s', 'k-', '1234567890abcdefghijklmnop'].join('');
    const next = updateProjectConfig(
      aggregate,
      { model: syntheticApiKey },
      aggregate.revision,
      clock.now(),
      runtime,
    );
    await expect(
      session.commit({
        transactionId: makeTransactionId(),
        commitId: makeCommitId(),
        expectedRevision: aggregate.revision,
        expectedHeadCommitId: session.headCommitId,
        nextAggregate: next,
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_SCHEMA_INVALID' });
    expect(await readFile(path.join(target, 'project.json'), 'utf8')).not.toContain('sk-');
    await session.close();
  });

  it('rejects retrieval query hash mismatches on write and hydration', async () => {
    const { target, session, aggregate, clock } = await setup('检索哈希项目');
    const query = '合成检索查询';
    const report = {
      id: retrievalReportIdSchema.parse(uuid(700)),
      createdAt: clock.now(),
      knowledgeVersion: 'synthetic-v1',
      retrievalEngineVersion: 'test-v1',
      redactedQueryText: query,
      querySha256: sha256(Buffer.from('错误查询', 'utf8')),
      factHints: { dates: [], times: [], locations: [], participants: [], missing: [] },
      hits: [],
    };
    const mismatched = recordRetrieval(aggregate, report, aggregate.revision, clock.now(), runtime);
    await expect(
      session.commit({
        transactionId: makeTransactionId(),
        commitId: makeCommitId(),
        expectedRevision: aggregate.revision,
        expectedHeadCommitId: session.headCommitId,
        nextAggregate: mismatched,
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_HASH_MISMATCH' });

    const valid = recordRetrieval(
      aggregate,
      { ...report, querySha256: sha256(Buffer.from(query, 'utf8')) },
      aggregate.revision,
      clock.now(),
      runtime,
    );
    await commitUpdate(session, aggregate, valid);
    await session.close();
    const head = projectHeadV1Schema.parse(
      JSON.parse(await readFile(path.join(target, 'project.json'), 'utf8')),
    );
    const retrievalRef = head.state.retrievalReports[0];
    if (retrievalRef === undefined) throw new Error('missing retrieval record');
    const recordTarget = path.join(target, ...retrievalRef.relativePath.split('/'));
    const record = JSON.parse(await readFile(recordTarget, 'utf8')) as {
      payload: Record<string, unknown>;
    };
    const tamperedBytes = serializeJson({
      ...record,
      payload: { ...record.payload, querySha256: sha256(Buffer.from('另一查询', 'utf8')) },
    });
    await writeFile(recordTarget, tamperedBytes);
    const tamperedState = {
      ...head.state,
      retrievalReports: [
        {
          ...retrievalRef,
          sha256: sha256(tamperedBytes),
          byteLength: tamperedBytes.byteLength,
        },
      ],
    };
    await expect(
      hydrateProjectState(target, head.projectId, head.revision, tamperedState),
    ).rejects.toMatchObject({ code: 'PROJECT_HASH_MISMATCH' });
  });

  it('rejects self-consistent credential-shaped legacy text on hydrate, open, and later commits', async () => {
    const { target, session, aggregate, clock } = await setup('legacy credential project');
    await session.close();
    const secretText = `legacy content ${['s', 'k-', 'abcdefghijklmnop'].join('')}`;
    const secretRef = artifact(aggregate.minutes.contentRef.relativePath, secretText);
    const head = projectHeadV1Schema.parse(
      JSON.parse(await readFile(path.join(target, 'project.json'), 'utf8')),
    );
    const minutesRecordTarget = path.join(
      target,
      ...head.state.currentMinutes.relativePath.split('/'),
    );
    const minutesRecord = JSON.parse(await readFile(minutesRecordTarget, 'utf8')) as {
      payload: Record<string, unknown>;
    };
    const minutesRecordBytes = serializeJson({
      ...minutesRecord,
      payload: { ...minutesRecord.payload, contentRef: secretRef },
    });
    await writeFile(minutesRecordTarget, minutesRecordBytes);
    await writeFile(path.join(target, ...secretRef.relativePath.split('/')), secretText, 'utf8');
    const nextMinutesRecordRef = {
      ...head.state.currentMinutes,
      sha256: sha256(minutesRecordBytes),
      byteLength: minutesRecordBytes.byteLength,
    };
    const nextState = { ...head.state, currentMinutes: nextMinutesRecordRef };
    await expect(
      hydrateProjectState(target, head.projectId, head.revision, nextState),
    ).rejects.toMatchObject({ code: 'PROJECT_SCHEMA_INVALID' });

    const replacements = new Map<string, { sha256: string; byteLength: number }>([
      [
        nextMinutesRecordRef.relativePath,
        { sha256: nextMinutesRecordRef.sha256, byteLength: nextMinutesRecordRef.byteLength },
      ],
      [secretRef.relativePath, { sha256: secretRef.sha256, byteLength: secretRef.byteLength }],
    ]);
    await resignHeadState(target, nextState, (writes) =>
      writes.map((write) => {
        const replacement = replacements.get(String(write.relativePath));
        return replacement === undefined ? write : { ...write, ...replacement };
      }),
    );
    await expect(
      openProject({ root: target, appVersion: runtime.appVersion }),
    ).rejects.toMatchObject({ code: 'PROJECT_SCHEMA_INVALID' });

    const tamperedHeadText = await readFile(path.join(target, 'project.json'), 'utf8');
    const tamperedHead = projectHeadV1Schema.parse(JSON.parse(tamperedHeadText));
    const secretAggregate: ProjectAggregateV1 = {
      ...aggregate,
      minutes: { ...aggregate.minutes, contentRef: secretRef },
    };
    const lock = await ProjectLock.acquire(path.join(target, '.news-writer'), runtime.appVersion);
    const manual = new ProjectSession(target, `manual-${randomUUID()}`, lock, tamperedHead, {
      aggregate: secretAggregate,
      textArtifacts: new Map([[secretRef.relativePath, Buffer.from(secretText, 'utf8')]]),
    });
    const next = updateProjectConfig(
      secretAggregate,
      { maxWords: 900 },
      secretAggregate.revision,
      clock.now(),
      runtime,
    );
    await expect(
      manual.commit({
        transactionId: makeTransactionId(),
        commitId: makeCommitId(),
        expectedRevision: secretAggregate.revision,
        expectedHeadCommitId: manual.headCommitId,
        nextAggregate: next,
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_SCHEMA_INVALID' });
    expect(await readFile(path.join(target, 'project.json'), 'utf8')).toBe(tamperedHeadText);
    await manual.close();
  });

  it('does not let another transaction adopt pre-commit immutable objects', async () => {
    const { session, aggregate, clock, ids } = await setup('事务归属项目');
    const minutesText = '活动时间：2026年8月10日。\n';
    const minutesRef = artifact(
      `content/minutes/${aggregate.minutes.minuteId}/${uuid(4)}.md`,
      minutesText,
    );
    const next = saveMinutes(aggregate, minutesRef, aggregate.revision, {
      clock,
      ids,
      runtime,
    });
    const firstTransactionId = makeTransactionId();
    setCommitBarrierForTest((barrier) => {
      if (barrier === 'afterPayloadPublish') throw new Error('leave owned objects');
    });
    await expect(
      session.commit({
        transactionId: firstTransactionId,
        commitId: makeCommitId(),
        expectedRevision: aggregate.revision,
        expectedHeadCommitId: session.headCommitId,
        nextAggregate: next,
        artifacts: new Map([[minutesRef.relativePath, minutesText]]),
      }),
    ).rejects.toThrow('leave owned objects');
    setCommitBarrierForTest();
    await expect(
      session.commit({
        transactionId: makeTransactionId(),
        commitId: makeCommitId(),
        expectedRevision: aggregate.revision,
        expectedHeadCommitId: session.headCommitId,
        nextAggregate: next,
        artifacts: new Map([[minutesRef.relativePath, minutesText]]),
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_CONFLICT' });
    await session.close();
  });

  it('rejects a fresh second lock and only recovers a stale lock explicitly', async () => {
    const { target, session } = await setup('锁项目');
    await expect(
      ProjectLock.acquire(path.join(target, '.news-writer'), '0.1.0'),
    ).rejects.toMatchObject({
      code: 'PROJECT_LOCKED',
    });
    await session.close();

    const lockRoot = path.join(target, '.news-writer', 'write.lock');
    await mkdir(lockRoot);
    const instanceId = uuid(950);
    await writeFile(
      path.join(lockRoot, 'owner.json'),
      serializeJson({
        format: 'news-writer-lock-owner',
        storageVersion: 1,
        instanceId,
        pid: 2_147_483_647,
        processStartedAt: '2000-01-01T00:00:00.000Z',
        appVersion: '0.1.0',
        heartbeatAt: '2000-01-01T00:00:00.000Z',
      }),
    );
    const old = new Date('2000-01-01T00:00:00.000Z');
    await utimes(lockRoot, old, old);
    await expect(openProject({ root: target, appVersion: '0.1.0' })).rejects.toMatchObject({
      code: 'PROJECT_LOCK_RECOVERY_REQUIRED',
      observedLockInstanceId: instanceId,
    });
    await recoverProjectLock(target, instanceId, true);
    const reopened = await openProject({ root: target, appVersion: '0.1.0' });
    expect(reopened.read().revision).toBe(0);
    await reopened.close();
  });

  it('allows only one of two real Node processes to hold the project lock', async () => {
    const { target, session } = await setup('双进程锁项目');
    await session.close();
    const first = fork(workerPath, ['hold-lock', target], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    expect(await waitForMessage(first)).toMatchObject({ status: 'locked' });
    const second = fork(workerPath, ['try-open', target], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    expect(await waitForMessage(second)).toMatchObject({
      status: 'error',
      code: 'PROJECT_LOCKED',
    });
    await waitForExit(second);
    first.kill('SIGKILL');
    await waitForExit(first);
    await expireAndRecoverKilledLock(target);
  });

  it.each([
    ['afterStagingPayloads', 0],
    ['afterPrepare', 0],
    ['afterPayloadPublish', 0],
    ['afterSnapshotPublish', 0],
    ['afterCommitPublish', 1],
    ['afterHeadReplace', 1],
  ] satisfies Array<[CommitBarrier, number]>)(
    'recovers after a child process is killed at %s',
    async (barrier, expectedRevision) => {
      const { parent, target, session } = await setup(`强杀-${barrier}`);
      await session.close();
      const markerPath = path.join(parent, `${barrier}.marker`);
      const child = fork(workerPath, ['crash', target, barrier, markerPath], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      expect(await waitForExit(child)).not.toBe(0);
      expect(await readFile(markerPath, 'utf8')).toBe(`${barrier}\n`);
      await expireAndRecoverKilledLock(target);
      const reopened = await openProject({ root: target, appVersion: '0.1.0' });
      expect(reopened.read().revision).toBe(expectedRevision);
      if (expectedRevision === 1) {
        expect(reopened.read().projectConfig.model).toBe(`child-${barrier}`);
      }
      await reopened.close();
    },
  );

  it.each([
    ['afterStagingPayloads', false],
    ['afterPrepare', false],
    ['afterPayloadPublish', false],
    ['afterSnapshotPublish', false],
    ['afterCommitPublish', true],
    ['afterHeadReplace', true],
  ] satisfies Array<[CommitBarrier, boolean]>)(
    'atomically recovers task, version, and latest after completion is killed at %s',
    async (barrier, committed) => {
      const { parent, target, savingRevision, taskId, versionId } = await setupSavingTask(
        `完成强杀-${barrier}`,
      );
      const markerPath = path.join(parent, `complete-${barrier}.marker`);
      const child = fork(workerPath, ['crash-complete', target, barrier, markerPath], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      expect(await waitForExit(child)).not.toBe(0);
      expect(await readFile(markerPath, 'utf8')).toBe(`${barrier}\n`);
      await expireAndRecoverKilledLock(target);
      const reopened = await openProject({ root: target, appVersion: '0.1.0' });
      const recovered = reopened.read();
      expect(recovered.revision).toBe(savingRevision + (committed ? 1 : 0));
      expect(recovered.versions).toHaveLength(committed ? 1 : 0);
      expect(recovered.latestVersionId).toBe(committed ? versionId : null);
      expect(recovered.tasks.find((task) => task.id === taskId)?.status).toBe(
        committed ? 'succeeded' : 'saving',
      );
      await reopened.close();
    },
  );

  it.runIf(process.platform === 'win32')(
    'uses bounded retry and recovery semantics for a real Windows sharing violation',
    async () => {
      const { target, session, aggregate, clock } = await setup('共享冲突项目');
      let blocker: ChildProcess | undefined;
      const ready = new Promise<void>((resolve, reject) => {
        setCommitBarrierForTest(async (barrier) => {
          if (barrier !== 'afterCommitPublish') return;
          const script = [
            '$stream=[IO.File]::Open($env:NW_LOCK_TARGET,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)',
            "[Console]::Out.WriteLine('READY')",
            '[Console]::Out.Flush()',
            '[Console]::In.ReadLine() | Out-Null',
            '$stream.Dispose()',
          ].join(';');
          blocker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
            env: { ...process.env, NW_LOCK_TARGET: path.join(target, 'project.json') },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          });
          blocker.once('error', reject);
          blocker.stdout?.once('data', (chunk) => {
            if (String(chunk).includes('READY')) resolve();
          });
          await ready;
        });
      });
      await expect(
        commitConfig(session, aggregate, clock, 'sharing-conflict'),
      ).rejects.toMatchObject({
        code: 'PROJECT_RECOVERY_REQUIRED',
      });
      blocker?.stdin?.write('\n');
      if (blocker !== undefined) await waitForExit(blocker);
      setCommitBarrierForTest();
      const staleHead = projectHeadV1Schema.parse(
        JSON.parse(await readFile(path.join(target, 'project.json'), 'utf8')),
      );
      expect(staleHead.revision).toBe(0);
      await session.close();
      const reopened = await openProject({ root: target, appVersion: '0.1.0' });
      expect(reopened.read().revision).toBe(1);
      await reopened.close();
    },
    15_000,
  );

  it('rejects two valid direct successor commits as ambiguous', async () => {
    const { target, session, aggregate, clock } = await setup('分叉提交项目');
    setCommitBarrierForTest((barrier) => {
      if (barrier === 'afterCommitPublish') throw new Error('hold first');
    });
    await expect(commitConfig(session, aggregate, clock, 'first')).rejects.toMatchObject({
      code: 'PROJECT_RECOVERY_REQUIRED',
    });
    setCommitBarrierForTest();
    await session.close();

    const commitsRoot = path.join(target, '.news-writer', 'commits');
    const firstName = (await readdir(commitsRoot)).find((name) => name.startsWith('1-'));
    if (firstName === undefined) throw new Error('missing first successor');
    const held = path.join(target, '.news-writer', 'held-first.json');
    await rename(path.join(commitsRoot, firstName), held);

    const secondSession = await openProject({ root: target, appVersion: '0.1.0' });
    setCommitBarrierForTest((barrier) => {
      if (barrier === 'afterCommitPublish') throw new Error('hold second');
    });
    await expect(commitConfig(secondSession, aggregate, clock, 'second')).rejects.toMatchObject({
      code: 'PROJECT_RECOVERY_REQUIRED',
    });
    setCommitBarrierForTest();
    await secondSession.close();
    await rename(held, path.join(commitsRoot, firstName));

    await expect(openProject({ root: target, appVersion: '0.1.0' })).rejects.toMatchObject({
      code: 'PROJECT_RECOVERY_AMBIGUOUS',
    });
  });

  it('blocks credential-shaped text from entering project artifacts', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'news-writer-secret-'));
    roots.push(parent);
    const secretText = ['token: sk', '1234567890abcdefghijklmnop'].join('-');
    const minutesRef = artifact(`content/minutes/${uuid(2)}/${uuid(3)}.md`, secretText);
    const aggregate = createProject(
      {
        name: '凭据阻断项目',
        profile: 'official',
        minutesContentRef: minutesRef,
        runtime: { appVersion: '0.1.0', electronVersion: '43.3.0', chromiumVersion: '150.0.0' },
      },
      { ids: new FixedIds(), clock: new FixedClock() },
    );
    await expect(
      createProjectOnDisk({
        root: path.join(parent, 'blocked'),
        appVersion: '0.1.0',
        aggregate,
        artifacts: new Map([[minutesRef.relativePath, secretText]]),
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_SCHEMA_INVALID' });
  });
});
