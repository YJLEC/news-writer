import {
  sha256Schema,
  timestampSchema,
  type Clock,
  type EntityKind,
  type IdGenerator,
  type ProjectRelativePath,
  type SafeAppError,
  type Sha256,
  type TextArtifactRef,
} from '@news-writer/shared';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  DomainRuleError,
  DEFAULT_GENERATION_CONFIG,
  addComment,
  archiveProject,
  commentRecordSchema,
  commitSuccessfulVersion,
  createProject,
  deleteComment,
  editComment,
  getBranches,
  getCurrentVersionChain,
  queueTask,
  parseVersionId,
  resolveGenerationConfig,
  restoreProject,
  promptRecordSchema,
  retrievalReportSchema,
  setLatestVersion,
  taskRecordSchema,
  transitionTask,
  updateProjectConfig,
  validateProjectAggregate,
} from './index';

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

class FixedIds implements IdGenerator {
  #next = 1;
  readonly generated: Array<{ kind: EntityKind; id: string }> = [];

  next(kind: EntityKind): string {
    const id = uuid(this.#next++);
    this.generated.push({ kind, id });
    return id;
  }
}

class FixedClock implements Clock {
  #tick = 0;

  now() {
    this.#tick += 1;
    return timestampSchema.parse(
      `2026-08-09T01:00:${this.#tick.toString().padStart(2, '0')}.0000000Z`,
    );
  }
}

const hash = (character: string): Sha256 => sha256Schema.parse(character.repeat(64));

const ref = (
  relativePath: string,
  content: string,
  sha256: Sha256,
  mediaType: TextArtifactRef['mediaType'] = 'text/markdown',
): TextArtifactRef => ({
  relativePath: relativePath as ProjectRelativePath,
  sha256,
  byteLength: Buffer.byteLength(content),
  mediaType,
  encoding: 'utf-8',
});

const defaults = {
  model: 'deepseek-v4-pro',
  reasoningEffort: 'medium' as const,
  targetChannel: '学院网站',
  maxWords: 1200,
  requestTimeoutMs: 120_000,
};

describe('generation defaults', () => {
  it('uses the approved new-task model without narrowing historical model schemas', () => {
    expect(DEFAULT_GENERATION_CONFIG.model).toBe('deepseek-v4-pro');
    expect(typeof taskRecordSchema.safeParse).toBe('function');
  });
});

const runtime = {
  appVersion: '0.1.0',
  electronVersion: '43.3.0',
  chromiumVersion: '150.0.0',
};

const nextRuntime = { ...runtime, appVersion: '0.2.0' };

const contentHash = (content: string): Sha256 =>
  sha256Schema.parse(createHash('sha256').update(content, 'utf8').digest('hex'));

const setupProject = () => {
  const ids = new FixedIds();
  const clock = new FixedClock();
  const minutesText = '活动时间：2026年8月9日。';
  const minutes = ref(`content/minutes/${uuid(2)}/${uuid(3)}.md`, minutesText, hash('a'));
  const project = createProject(
    {
      name: '合成测试项目',
      profile: 'official',
      minutesContentRef: minutes,
      runtime,
    },
    { ids, clock },
  );
  return { project, ids, clock, minutesText };
};

const queueAndComplete = (
  projectInput: ReturnType<typeof setupProject>['project'],
  ids: FixedIds,
  clock: FixedClock,
  kind: 'draftGeneration' | 'aiReview' | 'commentRevision',
  versionNumber: number,
  contents: Map<string, string>,
) => {
  const expectedTaskId = uuid(ids.generated.length === 3 ? 5 : ids.generated.length + 2);
  const promptText = `prompt-${versionNumber}`;
  const promptRef = ref(
    `content/prompts/${expectedTaskId}/0.txt`,
    promptText,
    hash(versionNumber === 1 ? 'b' : versionNumber === 2 ? 'd' : 'f'),
    'text/plain',
  );
  contents.set(promptRef.relativePath, promptText);
  let project = queueTask(
    projectInput,
    {
      kind,
      messages: [{ role: 'user', contentRef: promptRef }],
      editedByUser: false,
      upstream: {
        promptInputFingerprint: contentHash(promptText),
        currentInputFingerprint: contentHash(promptText),
        staleResolution: 'current',
      },
      config: {
        defaults,
      },
    },
    projectInput.revision,
    { ids, clock, runtime },
  );
  const task = project.tasks.at(-1);
  if (task === undefined) throw new Error('missing task');
  for (const status of ['preparing', 'requesting', 'processing'] as const) {
    project = transitionTask(project, task.id, { status }, project.revision, clock.now(), runtime);
  }
  const proposedVersionId = parseVersionId(uuid(100 + versionNumber));
  project = transitionTask(
    project,
    task.id,
    {
      status: 'saving',
      successTransactionId: uuid(200 + versionNumber),
      proposedVersionId,
    },
    project.revision,
    clock.now(),
    runtime,
  );
  const versionText = `版本${versionNumber}标题\n\n版本${versionNumber}正文。`;
  const versionRef = ref(
    `content/versions/${proposedVersionId}.md`,
    versionText,
    hash(versionNumber === 1 ? 'c' : versionNumber === 2 ? 'e' : '1'),
  );
  contents.set(versionRef.relativePath, versionText);
  project = commitSuccessfulVersion(
    project,
    { taskId: task.id, contentRef: versionRef, createdAt: clock.now() },
    project.revision,
    { readText: (artifact) => contents.get(artifact.relativePath) },
    runtime,
  );
  return { project, versionText, versionId: proposedVersionId };
};

const queueDraftTask = (
  project: ReturnType<typeof setupProject>['project'],
  ids: FixedIds,
  clock: FixedClock,
) => {
  const promptText = 'draft prompt';
  const promptRef = ref(
    `content/prompts/${uuid(ids.generated.length + 2)}/0.txt`,
    promptText,
    contentHash(promptText),
    'text/plain',
  );
  return queueTask(
    project,
    {
      kind: 'draftGeneration',
      messages: [{ role: 'user', contentRef: promptRef }],
      editedByUser: false,
      upstream: {
        promptInputFingerprint: contentHash(promptText),
        currentInputFingerprint: contentHash(promptText),
        staleResolution: 'current',
      },
      config: { defaults },
    },
    project.revision,
    { ids, clock, runtime },
  );
};

const transitionThrough = (
  project: ReturnType<typeof setupProject>['project'],
  taskId: (typeof project.tasks)[number]['id'],
  statuses: ReadonlyArray<'preparing' | 'requesting' | 'processing'>,
  clock: FixedClock,
) =>
  statuses.reduce(
    (current, status) =>
      transitionTask(current, taskId, { status }, current.revision, clock.now(), runtime),
    project,
  );

const taskError = (code: SafeAppError['code'], at: SafeAppError['occurredAt']): SafeAppError => ({
  code,
  occurredAt: at,
  safeMessage: `Synthetic ${code}`,
  retryable: false,
});

describe('configuration resolution', () => {
  it('resolves each field independently and records the winning source', () => {
    const resolved = resolveGenerationConfig({
      profile: 'other',
      defaults,
      user: { model: 'user-model', maxWords: 1_200 },
      project: { maxWords: 800, targetChannel: '内网' },
      task: { requestTimeoutMs: 5_000 },
    });
    expect(resolved.values).toEqual({
      ...defaults,
      model: 'user-model',
      maxWords: 800,
      targetChannel: '内网',
      requestTimeoutMs: 5_000,
    });
    expect(resolved.sources).toEqual({
      model: 'user',
      reasoningEffort: 'default',
      targetChannel: 'project',
      maxWords: 'project',
      requestTimeoutMs: 'task',
    });
    const forbiddenCredentialField = ['api', 'Key'].join('');
    expect(() =>
      resolveGenerationConfig({
        profile: 'official',
        defaults,
        task: { [forbiddenCredentialField]: 'x' },
      }),
    ).toThrow();
    expect(() =>
      resolveGenerationConfig({ profile: 'official', defaults, task: { model: undefined } }),
    ).toThrow();
  });

  it('derives queued task sources from strict layers and the aggregate project config', () => {
    const { project, ids, clock } = setupProject();
    const configured = updateProjectConfig(
      project,
      { maxWords: 700, targetChannel: '项目渠道' },
      project.revision,
      clock.now(),
      nextRuntime,
    );
    const promptText = 'configured prompt';
    const promptRef = ref(
      'content/prompts/configured/0.txt',
      promptText,
      contentHash(promptText),
      'text/plain',
    );
    const input = {
      kind: 'draftGeneration' as const,
      messages: [{ role: 'user' as const, contentRef: promptRef }],
      editedByUser: false,
      upstream: {
        promptInputFingerprint: contentHash(promptText),
        currentInputFingerprint: contentHash(promptText),
        staleResolution: 'current' as const,
      },
      config: {
        defaults,
        user: { model: 'user-model', maxWords: 800 },
        task: { requestTimeoutMs: 5_000 },
      },
    };

    expect(() =>
      queueTask(
        configured,
        { ...input, configSnapshot: { sources: { model: 'task' } } } as never,
        configured.revision,
        { ids, clock, runtime },
      ),
    ).toThrow();
    expect(() =>
      queueTask(
        configured,
        { ...input, config: { ...input.config, project: { model: 'spoofed' } } } as never,
        configured.revision,
        { ids, clock, runtime },
      ),
    ).toThrow();
    expect(() =>
      queueTask(
        configured,
        { ...input, config: { ...input.config, task: { unknownField: true } } } as never,
        configured.revision,
        { ids, clock, runtime },
      ),
    ).toThrow();

    const queued = queueTask(configured, input, configured.revision, { ids, clock, runtime });
    expect(queued.tasks[0]?.configSnapshot.values).toMatchObject({
      model: 'user-model',
      maxWords: 700,
      targetChannel: '项目渠道',
      requestTimeoutMs: 5_000,
    });
    expect(queued.tasks[0]?.configSnapshot.sources).toEqual({
      model: 'user',
      reasoningEffort: 'default',
      targetChannel: 'project',
      maxWords: 'project',
      requestTimeoutMs: 'task',
    });
    expect(queued.lastWrittenWith).toEqual(runtime);
  });
});

describe('domain workflow', () => {
  it('creates deterministic projects and enforces archive write rules', () => {
    const { project, clock } = setupProject();
    expect(project.revision).toBe(0);
    expect(project.latestVersionId).toBeNull();
    const archived = archiveProject(project, 0, clock.now(), nextRuntime);
    expect(archived.lastWrittenWith).toEqual(nextRuntime);
    expect(archiveProject(archived, archived.revision, clock.now(), runtime)).toBe(archived);
    expect(() =>
      queueTask(archived, {} as never, archived.revision, {
        ids: new FixedIds(),
        clock,
        runtime,
      }),
    ).toThrow(DomainRuleError);
    const restored = restoreProject(archived, archived.revision, clock.now(), runtime);
    expect(restored.status).toBe('active');
    expect(restored.lastWrittenWith).toEqual(runtime);
    expect(restoreProject(restored, restored.revision, clock.now(), nextRuntime)).toBe(restored);
  });

  it('enforces task transitions and creates only nonempty successful versions', () => {
    const { project, ids, clock, minutesText } = setupProject();
    const contents = new Map([[project.minutes.contentRef.relativePath, minutesText]]);
    const completed = queueAndComplete(project, ids, clock, 'draftGeneration', 1, contents);
    expect(completed.project.latestVersionId).toBe(completed.versionId);
    expect(completed.project.versions).toHaveLength(1);
    expect(completed.project.tasks.at(-1)?.status).toBe('succeeded');
    expect(() =>
      transitionTask(
        completed.project,
        completed.project.tasks[0]!.id,
        { status: 'failed', error: {} as never },
        completed.project.revision,
        clock.now(),
        runtime,
      ),
    ).toThrow();
  });

  it('rejects empty generated content without changing the saving task or versions', () => {
    const { project, ids, clock } = setupProject();
    let current = queueDraftTask(project, ids, clock);
    const task = current.tasks[0]!;
    current = transitionThrough(current, task.id, ['preparing', 'requesting', 'processing'], clock);
    const proposedVersionId = parseVersionId(uuid(600));
    current = transitionTask(
      current,
      task.id,
      {
        status: 'saving',
        successTransactionId: uuid(601),
        proposedVersionId,
      },
      current.revision,
      clock.now(),
      runtime,
    );
    const whitespace = ' \n\t';
    const emptyRef = ref(
      `content/versions/${proposedVersionId}.md`,
      whitespace,
      contentHash(whitespace),
    );

    expect(() =>
      commitSuccessfulVersion(
        current,
        { taskId: task.id, contentRef: emptyRef, createdAt: clock.now() },
        current.revision,
        { readText: () => whitespace },
        nextRuntime,
      ),
    ).toThrow(DomainRuleError);
    expect(current.tasks[0]?.status).toBe('saving');
    expect(current.versions).toHaveLength(0);
    expect(current.latestVersionId).toBeNull();
  });

  it.each([
    ['failed', 'SERVICE_UNAVAILABLE'],
    ['cancelled', 'REQUEST_CANCELLED'],
    ['timedOut', 'REQUEST_TIMEOUT'],
  ] as const)('supports the complete processing -> %s terminal chain', (status, errorCode) => {
    const { project, ids, clock } = setupProject();
    let current = queueDraftTask(project, ids, clock);
    const task = current.tasks[0]!;
    current = transitionThrough(current, task.id, ['preparing', 'requesting', 'processing'], clock);
    const at = clock.now();
    current = transitionTask(
      current,
      task.id,
      { status, error: taskError(errorCode, at) },
      current.revision,
      at,
      nextRuntime,
    );

    expect(current.tasks[0]?.history.map((entry) => entry.status)).toEqual([
      'queued',
      'preparing',
      'requesting',
      'processing',
      status,
    ]);
    expect(current.tasks[0]?.status).toBe(status);
    const terminal = current.tasks[0];
    if (terminal === undefined || !('completedAt' in terminal)) {
      throw new Error('missing terminal task');
    }
    expect(terminal.completedAt).toBe(terminal.updatedAt);
    expect(
      taskRecordSchema.safeParse({
        ...terminal,
        completedAt: terminal.createdAt,
      }).success,
    ).toBe(false);
    expect(current.lastWrittenWith).toEqual(nextRuntime);
    expect(current.versions).toHaveLength(0);
  });

  it('allows saving -> failed and strips unpublished version proposal fields', () => {
    const { project, ids, clock } = setupProject();
    let current = queueDraftTask(project, ids, clock);
    const task = current.tasks[0]!;
    current = transitionThrough(current, task.id, ['preparing', 'requesting', 'processing'], clock);
    current = transitionTask(
      current,
      task.id,
      {
        status: 'saving',
        successTransactionId: uuid(610),
        proposedVersionId: parseVersionId(uuid(611)),
      },
      current.revision,
      clock.now(),
      runtime,
    );
    const at = clock.now();
    current = transitionTask(
      current,
      task.id,
      { status: 'failed', error: taskError('PROJECT_IO_ERROR', at) },
      current.revision,
      at,
      nextRuntime,
    );

    expect(current.tasks[0]?.status).toBe('failed');
    expect(current.tasks[0]?.history.at(-2)?.status).toBe('saving');
    expect(current.tasks[0]).not.toHaveProperty('proposedVersionId');
    expect(current.versions).toHaveLength(0);
  });

  it('persists structured fact overrides with queued tasks', () => {
    const { project, ids, clock } = setupProject();
    const promptText = 'draft with confirmed facts';
    const promptRef = ref(
      'content/prompts/facts/0.txt',
      promptText,
      contentHash(promptText),
      'text/plain',
    );
    const queued = queueTask(
      project,
      {
        kind: 'draftGeneration',
        messages: [{ role: 'user', contentRef: promptRef }],
        editedByUser: false,
        upstream: {
          promptInputFingerprint: contentHash(promptText),
          currentInputFingerprint: contentHash(promptText),
          staleResolution: 'current',
        },
        config: { defaults },
        factOverrides: {
          date: { mode: 'manual', value: '2026年8月' },
          location: { mode: 'none' },
        },
      },
      project.revision,
      { ids, clock, runtime },
    );
    expect(queued.tasks.at(-1)?.factOverrides).toEqual({
      date: { mode: 'manual', value: '2026年8月' },
      location: { mode: 'none' },
    });
  });

  it('copies fact overrides into the immutable successful version snapshot', () => {
    const { project, ids, clock } = setupProject();
    const contents = new Map<string, string>();
    const promptText = 'draft with facts';
    const promptRef = ref(
      'content/prompts/facts-version/0.txt',
      promptText,
      contentHash(promptText),
      'text/plain',
    );
    contents.set(promptRef.relativePath, promptText);
    let queued = queueTask(
      project,
      {
        kind: 'draftGeneration',
        messages: [{ role: 'user', contentRef: promptRef }],
        editedByUser: false,
        upstream: {
          promptInputFingerprint: contentHash(promptText),
          currentInputFingerprint: contentHash(promptText),
          staleResolution: 'current',
        },
        config: { defaults },
        factOverrides: { date: { mode: 'manual', value: '2026年8月' } },
      },
      project.revision,
      { ids, clock, runtime },
    );
    const task = queued.tasks.at(-1)!;
    for (const status of ['preparing', 'requesting', 'processing'] as const)
      queued = transitionTask(queued, task.id, { status }, queued.revision, clock.now(), runtime);
    queued = transitionTask(
      queued,
      task.id,
      {
        status: 'saving',
        successTransactionId: uuid(700),
        proposedVersionId: parseVersionId(uuid(701)),
      },
      queued.revision,
      clock.now(),
      runtime,
    );
    const versionText = '标题\n\n正文。';
    const versionRef = ref(
      'content/versions/facts-version.md',
      versionText,
      contentHash(versionText),
    );
    const completed = commitSuccessfulVersion(
      queued,
      { taskId: task.id, contentRef: versionRef, createdAt: clock.now() },
      queued.revision,
      {
        readText: (candidate) =>
          candidate.relativePath === versionRef.relativePath
            ? versionText
            : contents.get(candidate.relativePath),
      },
      runtime,
    );
    expect(completed.versions.at(-1)?.factOverrides).toEqual({
      date: { mode: 'manual', value: '2026年8月' },
    });
  });

  it('orders mixed-precision comment snapshots and rejects corrupted snapshot metadata', () => {
    const { project, ids, clock, minutesText } = setupProject();
    const contents = new Map([[project.minutes.contentRef.relativePath, minutesText]]);
    const completed = queueAndComplete(project, ids, clock, 'draftGeneration', 1, contents);
    const version = completed.project.versions[0]!;
    const anchor = {
      kind: 'textQuote' as const,
      contentSha256: version.contentRef.sha256,
      start: 0,
      end: 1,
      exact: '版',
      prefix: '',
      suffix: '本',
    };
    const earlier = commentRecordSchema.parse({
      id: uuid(801),
      revision: 0,
      versionId: version.id,
      anchor,
      quotedText: anchor.exact,
      body: '较早批注',
      createdAt: '2026-08-09T00:00:00.123Z',
      updatedAt: '2026-08-09T00:00:00.123Z',
    });
    const later = commentRecordSchema.parse({
      ...earlier,
      id: uuid(800),
      body: '较晚批注',
      createdAt: '2026-08-09T00:00:00.1230001Z',
      updatedAt: '2026-08-09T00:00:00.1230001Z',
    });
    const withComments = { ...completed.project, comments: [later, earlier] };
    const promptText = 'revision prompt';
    const promptRef = ref(
      `content/prompts/${uuid(ids.generated.length + 2)}/0.txt`,
      promptText,
      contentHash(promptText),
      'text/plain',
    );
    const queued = queueTask(
      withComments,
      {
        kind: 'commentRevision',
        messages: [{ role: 'user', contentRef: promptRef }],
        editedByUser: false,
        upstream: {
          promptInputFingerprint: promptRef.sha256,
          currentInputFingerprint: promptRef.sha256,
          staleResolution: 'current',
        },
        config: { defaults },
      },
      withComments.revision,
      { ids, clock, runtime },
    );
    const task = queued.tasks.at(-1)!;
    expect(task.commentSnapshot.map((comment) => comment.id)).toEqual([earlier.id, later.id]);
    expect(task.commentSnapshotAt).toBe(task.createdAt);
    expect(taskRecordSchema.safeParse({ ...task, commentSnapshot: [] }).success).toBe(false);
    expect(
      taskRecordSchema.safeParse({
        ...task,
        commentSnapshotAt: '2026-08-09T00:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      validateProjectAggregate({
        ...queued,
        tasks: [{ ...task, commentSnapshot: [earlier, earlier] }],
      }).some((issue) => issue.code === 'COMMENT_SNAPSHOT_INVALID'),
    ).toBe(true);
  });

  it('keeps comments with their version across rollback and branching', () => {
    const { project, ids, clock, minutesText } = setupProject();
    const contents = new Map([[project.minutes.contentRef.relativePath, minutesText]]);
    const first = queueAndComplete(project, ids, clock, 'draftGeneration', 1, contents);
    const start = first.versionText.indexOf('正文');
    const anchor = {
      kind: 'textQuote' as const,
      contentSha256: first.project.versions[0]!.contentRef.sha256,
      start,
      end: start + 2,
      exact: '正文',
      prefix: '',
      suffix: '。',
    };
    let current = addComment(
      first.project,
      { versionId: first.versionId, anchor, body: '调整表达' },
      first.project.revision,
      {
        ids,
        clock,
        runtime,
        artifacts: { readText: (artifact) => contents.get(artifact.relativePath) },
      },
    );
    const snapshotBody = current.comments[0]!.body;
    const second = queueAndComplete(current, ids, clock, 'commentRevision', 2, contents);
    expect(
      second.project.comments.filter((comment) => comment.versionId === second.versionId),
    ).toHaveLength(0);

    current = setLatestVersion(
      second.project,
      first.versionId,
      second.project.revision,
      clock.now(),
      runtime,
    );
    current = editComment(
      current,
      { commentId: current.comments[0]!.id, anchor, body: '按回溯后的意见调整' },
      current.revision,
      clock.now(),
      { readText: (artifact) => contents.get(artifact.relativePath) },
      runtime,
    );
    const deleted = deleteComment(
      current,
      { commentId: current.comments[0]!.id },
      current.revision,
      clock.now(),
      runtime,
    );
    expect(deleted.comments).toHaveLength(0);
    expect(deleted.revision).toBe(current.revision + 1);
    const third = queueAndComplete(current, ids, clock, 'commentRevision', 3, contents);
    expect(second.project.tasks.at(-1)?.commentSnapshot[0]?.body).toBe(snapshotBody);
    expect(third.project.tasks.at(-1)?.commentSnapshot[0]?.body).toBe('按回溯后的意见调整');
    expect(getCurrentVersionChain(third.project).map((version) => version.id)).toEqual([
      first.versionId,
      third.versionId,
    ]);
    expect(
      getBranches(third.project).find((branch) => branch.versionId === second.versionId)
        ?.isOnCurrentChain,
    ).toBe(false);
    const restoredBranch = setLatestVersion(
      third.project,
      second.versionId,
      third.project.revision,
      clock.now(),
      runtime,
    );
    expect(getCurrentVersionChain(restoredBranch).at(-1)?.id).toBe(second.versionId);
  });

  it('reports cross-reference, anchor, and root corruption', () => {
    const { project } = setupProject();
    const corrupt = { ...project, latestVersionId: uuid(999) };
    expect(validateProjectAggregate(corrupt).some((issue) => issue.code === 'LATEST_INVALID')).toBe(
      true,
    );
  });

  it('rejects edited prompts without acknowledgement and malformed retrieval snapshots', () => {
    const promptBase = {
      id: uuid(700),
      createdAt: '2026-08-09T01:00:01.000Z',
      purpose: 'draftGeneration',
      messages: [
        {
          role: 'user',
          contentRef: ref('content/prompts/task/0.txt', '', hash('0'), 'text/plain'),
        },
      ],
      editedByUser: true,
      upstream: {
        promptInputFingerprint: hash('2'),
        currentInputFingerprint: hash('2'),
        staleResolution: 'current',
      },
    };
    expect(promptRecordSchema.safeParse(promptBase).success).toBe(false);
    expect(
      promptRecordSchema.safeParse({
        ...promptBase,
        editWarningAcknowledgedAt: '2026-08-09T01:00:00.999Z',
      }).success,
    ).toBe(true);
    expect(
      promptRecordSchema.safeParse({
        ...promptBase,
        editWarningAcknowledgedAt: '2026-08-09T01:00:00.999Z',
        upstream: {
          promptInputFingerprint: hash('2'),
          currentInputFingerprint: hash('3'),
          staleResolution: 'continued',
        },
      }).success,
    ).toBe(true);
    expect(
      promptRecordSchema.safeParse({
        ...promptBase,
        editWarningAcknowledgedAt: '2026-08-09T01:00:00.999Z',
        upstream: {
          promptInputFingerprint: hash('3'),
          currentInputFingerprint: hash('3'),
          previousPromptInputFingerprint: hash('2'),
          staleResolution: 'regenerated',
        },
      }).success,
    ).toBe(true);
    expect(
      promptRecordSchema.safeParse({
        ...promptBase,
        editWarningAcknowledgedAt: '2026-08-09T01:00:00.999Z',
        upstream: {
          promptInputFingerprint: hash('2'),
          currentInputFingerprint: hash('2'),
          staleResolution: 'continued',
        },
      }).success,
    ).toBe(false);

    const retrieval = {
      id: uuid(701),
      createdAt: '2026-08-09T01:00:01.000Z',
      knowledgeVersion: 'synthetic-v1',
      retrievalEngineVersion: 'test-v1',
      redactedQueryText: '合成检索词',
      querySha256: contentHash('合成检索词'),
      factHints: { dates: [], times: [], locations: [], participants: [], missing: [] },
      hits: [{ rank: 2, documentId: 'doc-1', title: '标题', score: 1, promptExcerpt: '摘录' }],
    };
    expect(retrievalReportSchema.safeParse(retrieval).success).toBe(false);
    expect(retrievalReportSchema.safeParse({ ...retrieval, hits: [] }).success).toBe(true);
    expect(
      retrievalReportSchema.safeParse({ ...retrieval, hits: [], sourcePath: 'C:/x' }).success,
    ).toBe(false);
  });

  it('does not allow cancellation after a task enters saving', () => {
    const { project, ids, clock } = setupProject();
    const expectedTaskId = uuid(ids.generated.length + 2);
    const promptRef = ref(
      `content/prompts/${expectedTaskId}/0.txt`,
      'prompt',
      hash('7'),
      'text/plain',
    );
    let current = queueTask(
      project,
      {
        kind: 'draftGeneration',
        messages: [{ role: 'user', contentRef: promptRef }],
        editedByUser: false,
        upstream: {
          promptInputFingerprint: promptRef.sha256,
          currentInputFingerprint: promptRef.sha256,
          staleResolution: 'current',
        },
        config: { defaults },
      },
      project.revision,
      { ids, clock, runtime },
    );
    const task = current.tasks[0]!;
    for (const status of ['preparing', 'requesting', 'processing'] as const) {
      current = transitionTask(
        current,
        task.id,
        { status },
        current.revision,
        clock.now(),
        runtime,
      );
    }
    current = transitionTask(
      current,
      task.id,
      {
        status: 'saving',
        successTransactionId: uuid(750),
        proposedVersionId: parseVersionId(uuid(751)),
      },
      current.revision,
      clock.now(),
      runtime,
    );
    expect(() =>
      transitionTask(
        current,
        task.id,
        {
          status: 'cancelled',
          error: {
            code: 'REQUEST_CANCELLED',
            occurredAt: clock.now(),
            safeMessage: 'Client stopped waiting; server processing may continue',
            retryable: false,
          },
        },
        current.revision,
        clock.now(),
        runtime,
      ),
    ).toThrow(DomainRuleError);
  });
});
