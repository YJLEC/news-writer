import {
  commitSuccessfulVersion,
  createProject,
  queueTask,
  transitionTask,
  validateNewsContent,
  type ProjectAggregateV1,
} from '@news-writer/domain';
import {
  createProjectOnDisk,
  makeCommitId,
  makeTransactionId,
  type ProjectSession,
} from '@news-writer/project';
import {
  projectRelativePathSchema,
  sha256Schema,
  timestampSchema,
  versionIdSchema,
  type Clock,
  type IdGenerator,
  type SafeAppError,
  type TextArtifactRef,
} from '@news-writer/shared';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ChatCompletionInput, ChatCompletionResult } from './contracts';
import { AiTaskCoordinator, type TaskArbitrationWinner, type TaskExecutionPort } from './execution';
import { AiSafeError, makeSafeError } from './errors';
import type { WorkerRun, WorkerRunner } from './worker';

const runtime = {
  appVersion: '0.1.0',
  electronVersion: '43.3.0',
  chromiumVersion: '150.0.0',
};

const uuid = (value: number): string =>
  `90000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

class FixedIds implements IdGenerator {
  #next = 1;
  next(): string {
    return uuid(this.#next++);
  }
  peek(offset = 0): string {
    return uuid(this.#next + offset);
  }
}

class TickClock implements Clock {
  #tick = 0;
  now() {
    this.#tick += 1;
    return timestampSchema.parse(
      new Date(Date.UTC(2026, 7, 9, 10, 0, 0, this.#tick)).toISOString(),
    );
  }
}

const artifact = (
  relativePath: string,
  content: string,
  mediaType: TextArtifactRef['mediaType'],
): TextArtifactRef => ({
  relativePath: projectRelativePathSchema.parse(relativePath),
  sha256: sha256Schema.parse(createHash('sha256').update(content).digest('hex')),
  byteLength: Buffer.byteLength(content),
  mediaType,
  encoding: 'utf-8',
});

class ImmediateRunner implements WorkerRunner {
  constructor(readonly result: ChatCompletionResult | SafeAppError) {}
  run(
    _taskId: Parameters<WorkerRunner['run']>[0],
    _input: ChatCompletionInput,
    _apiKey: string,
    onStatus: (status: 'requesting' | 'processing') => void,
  ): WorkerRun {
    onStatus('requesting');
    const failed = 'code' in this.result;
    if (!failed) onStatus('processing');
    return {
      result: failed ? Promise.reject(new AiSafeError(this.result)) : Promise.resolve(this.result),
      cancel: () => undefined,
      shutdown: () => Promise.resolve(),
      terminate: () => Promise.resolve(0),
    };
  }
}

class PendingRunner implements WorkerRunner {
  readonly started: Promise<void>;
  #resolveStarted!: () => void;

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.#resolveStarted = resolve;
    });
  }

  run(): WorkerRun {
    this.#resolveStarted();
    return {
      result: new Promise(() => undefined),
      cancel: () => undefined,
      shutdown: () => Promise.resolve(),
      terminate: () => Promise.resolve(0),
    };
  }
}

class ManualTimer {
  callback: (() => void) | undefined;
  set(callback: () => void): unknown {
    this.callback = callback;
    return 1;
  }
  clear(): void {
    this.callback = undefined;
  }
  fire(): void {
    this.callback?.();
  }
}

const domainContentAcceptance = {
  accept: (result: ChatCompletionResult): Promise<ChatCompletionResult> => {
    const validated = validateNewsContent(result.content);
    if (!validated.accepted) {
      return Promise.reject(
        new AiSafeError(
          makeSafeError(
            validated.reason === 'empty' ? 'EMPTY_RESPONSE' : 'CONTENT_INVALID',
            'The response is not a clean news article',
          ),
        ),
      );
    }
    return Promise.resolve({ ...result, content: validated.content });
  },
};

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

const createSerialExecutor = () => {
  let tail = Promise.resolve();
  return <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
};

describe('domain and project task integration', () => {
  it('uses existing transitions and the success transaction without creating a version in packages/ai', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'news-writer-ai-'));
    temporaryRoots.push(parent);
    const root = path.join(parent, 'project');
    const ids = new FixedIds();
    const clock = new TickClock();
    const minutesText = 'Synthetic event minutes.';
    const minutesRef = artifact(
      `content/minutes/${uuid(2)}/${uuid(3)}.md`,
      minutesText,
      'text/markdown',
    );
    const initial = createProject(
      { name: 'AI integration', profile: 'official', minutesContentRef: minutesRef, runtime },
      { ids, clock },
    );
    const session = await createProjectOnDisk({
      root,
      appVersion: '0.1.0',
      aggregate: initial,
      artifacts: new Map([[minutesRef.relativePath, minutesText]]),
    });
    const promptText = 'Write a synthetic report.';
    const promptRef = artifact(`content/prompts/${uuid(5)}/0.txt`, promptText, 'text/plain');
    let aggregate = queueTask(
      session.read(),
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
            model: 'deepseek-v4-pro',
            reasoningEffort: 'medium',
            targetChannel: '学院网站',
            maxWords: 900,
            requestTimeoutMs: 10_000,
          },
        },
      },
      0,
      { ids, clock, runtime },
    );
    aggregate = await commitUpdate(
      session,
      session.read(),
      aggregate,
      new Map([[promptRef.relativePath, promptText]]),
    );
    const task = aggregate.tasks[0];
    if (task === undefined) throw new Error('missing task');
    const proposedVersionId = versionIdSchema.parse(uuid(100));
    const successTransactionId = makeTransactionId();

    const serializeHostOperation = createSerialExecutor();
    const port: TaskExecutionPort = {
      transition: (status) =>
        serializeHostOperation(async () => {
          aggregate = session.read();
          const next = transitionTask(
            aggregate,
            task.id,
            { status },
            aggregate.revision,
            clock.now(),
            runtime,
          );
          aggregate = await commitUpdate(session, aggregate, next);
        }),
      fail: (status, error) =>
        serializeHostOperation(async () => {
          aggregate = session.read();
          const next = transitionTask(
            aggregate,
            task.id,
            { status, error },
            aggregate.revision,
            clock.now(),
            runtime,
          );
          aggregate = await commitUpdate(session, aggregate, next);
        }),
      arbitrateTask: (command) =>
        serializeHostOperation(async (): Promise<TaskArbitrationWinner> => {
          aggregate = session.read();
          const persistedTask = aggregate.tasks.find((candidate) => candidate.id === task.id);
          if (persistedTask === undefined) return 'conflict';
          if (persistedTask.status === 'saving' || persistedTask.status === 'succeeded') {
            return 'saving';
          }
          if (persistedTask.status === 'cancelled' || persistedTask.status === 'timedOut') {
            return persistedTask.status;
          }
          if (persistedTask.status === 'failed') return 'conflict';
          if (command.kind === 'save') {
            const next = transitionTask(
              aggregate,
              task.id,
              {
                status: 'saving',
                successTransactionId,
                proposedVersionId,
              },
              aggregate.revision,
              clock.now(),
              runtime,
            );
            aggregate = await commitUpdate(session, aggregate, next);
            return 'saving';
          }
          const terminal = transitionTask(
            aggregate,
            task.id,
            { status: command.kind === 'cancel' ? 'cancelled' : 'timedOut', error: command.error },
            aggregate.revision,
            clock.now(),
            runtime,
          );
          aggregate = await commitUpdate(session, aggregate, terminal);
          return command.kind === 'cancel' ? 'cancelled' : 'timedOut';
        }),
    };
    const result: ChatCompletionResult = {
      id: 'integration-completion',
      model: 'deepseek-v4-pro',
      content: 'Synthetic report content.',
      finishReason: 'stop',
    };
    const execution = new AiTaskCoordinator({ runner: new ImmediateRunner(result) }).execute({
      taskId: task.id,
      input: {
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: promptText }],
        reasoningEffort: 'medium',
        maxWords: 900,
      },
      apiKey: 'integration-test-credential',
      requestTimeoutMs: 10_000,
      contentAcceptance: domainContentAcceptance,
      port,
    });
    await expect(execution.outcome).resolves.toMatchObject({ status: 'saving' });
    expect(aggregate.versions).toHaveLength(0);
    expect(aggregate.latestVersionId).toBeNull();

    const savingTask = aggregate.tasks[0];
    if (savingTask?.status !== 'saving') throw new Error('task did not enter saving');
    const versionText = result.content;
    const versionRef = artifact(
      `content/versions/${proposedVersionId}.md`,
      versionText,
      'text/markdown',
    );
    const completedAt = clock.now();
    const completed = commitSuccessfulVersion(
      aggregate,
      { taskId: task.id, contentRef: versionRef, createdAt: completedAt },
      aggregate.revision,
      { readText: () => versionText },
      runtime,
    );
    aggregate = await session.commit({
      transactionId: successTransactionId,
      commitId: makeCommitId(),
      expectedRevision: aggregate.revision,
      expectedHeadCommitId: session.headCommitId,
      operation: 'completeTaskWithVersion',
      details: {
        operation: 'completeTaskWithVersion',
        successTransactionId,
        taskId: task.id,
        fromTaskSequence: savingTask.sequence,
        toTaskSequence: savingTask.sequence + 1,
        versionId: proposedVersionId,
        baseRevision: aggregate.revision,
        revision: aggregate.revision + 1,
      },
      nextAggregate: completed,
      artifacts: new Map([[versionRef.relativePath, versionText]]),
    });
    expect(aggregate.versions).toHaveLength(1);
    expect(aggregate.latestVersionId).toBe(proposedVersionId);

    const originalVersionHash = aggregate.versions[0]?.contentRef.sha256;
    const failures: Array<{
      source: SafeAppError | ChatCompletionResult;
      expectedCode: SafeAppError['code'];
    }> = [
      {
        source: makeSafeError('AUTH_REJECTED', 'Rejected', { httpStatus: 401 }),
        expectedCode: 'AUTH_REJECTED',
      },
      {
        source: makeSafeError('INSUFFICIENT_BALANCE', 'Insufficient balance', { httpStatus: 402 }),
        expectedCode: 'INSUFFICIENT_BALANCE',
      },
      {
        source: makeSafeError('RATE_LIMITED', 'Rate limited', { retryable: true, httpStatus: 429 }),
        expectedCode: 'RATE_LIMITED',
      },
      {
        source: makeSafeError('SERVICE_UNAVAILABLE', 'Unavailable', {
          retryable: true,
          httpStatus: 500,
        }),
        expectedCode: 'SERVICE_UNAVAILABLE',
      },
      {
        source: makeSafeError('SERVICE_UNAVAILABLE', 'Unavailable', {
          retryable: true,
          httpStatus: 503,
        }),
        expectedCode: 'SERVICE_UNAVAILABLE',
      },
      {
        source: makeSafeError('NETWORK_UNAVAILABLE', 'Network unavailable', { retryable: true }),
        expectedCode: 'NETWORK_UNAVAILABLE',
      },
      {
        source: makeSafeError('PROTOCOL_INVALID', 'Protocol invalid'),
        expectedCode: 'PROTOCOL_INVALID',
      },
      { source: makeSafeError('EMPTY_RESPONSE', 'Empty response'), expectedCode: 'EMPTY_RESPONSE' },
      {
        source: {
          ...result,
          id: 'invalid-content-refusal',
          content: '无法根据现有信息生成新闻稿，请提供活动地点。',
        },
        expectedCode: 'CONTENT_INVALID',
      },
      {
        source: {
          ...result,
          id: 'invalid-content-cannot-write',
          content: '无法撰写新闻稿，请补充活动时间。',
        },
        expectedCode: 'CONTENT_INVALID',
      },
      {
        source: {
          ...result,
          id: 'invalid-content-review',
          content: '审稿意见如下：地点信息缺失。',
        },
        expectedCode: 'CONTENT_INVALID',
      },
      {
        source: {
          ...result,
          id: 'invalid-content-problem-list',
          content: '以下为问题清单：地点、时间。',
        },
        expectedCode: 'CONTENT_INVALID',
      },
      {
        source: makeSafeError('TASK_INTERRUPTED', 'Worker interrupted', { retryable: true }),
        expectedCode: 'TASK_INTERRUPTED',
      },
    ];
    for (const [index, failure] of failures.entries()) {
      const reviewPromptText = `Review failure case ${index}.`;
      const reviewPromptRef = artifact(
        `content/prompts/${ids.peek(1)}/0.txt`,
        reviewPromptText,
        'text/plain',
      );
      const queuedReview = queueTask(
        aggregate,
        {
          kind: 'aiReview',
          messages: [{ role: 'user', contentRef: reviewPromptRef }],
          editedByUser: false,
          upstream: {
            promptInputFingerprint: reviewPromptRef.sha256,
            currentInputFingerprint: reviewPromptRef.sha256,
            staleResolution: 'current',
          },
          config: {
            defaults: {
              model: 'deepseek-v4-pro',
              reasoningEffort: 'medium',
              targetChannel: '学院网站',
              maxWords: 900,
              requestTimeoutMs: 10_000,
            },
          },
        },
        aggregate.revision,
        { ids, clock, runtime },
      );
      aggregate = await commitUpdate(
        session,
        aggregate,
        queuedReview,
        new Map([[reviewPromptRef.relativePath, reviewPromptText]]),
      );
      const reviewTask = aggregate.tasks.at(-1);
      if (reviewTask === undefined) throw new Error('missing review task');
      let savingArbitrationCalls = 0;
      const serializeFailureOperation = createSerialExecutor();
      const failurePort: TaskExecutionPort = {
        transition: (status) =>
          serializeFailureOperation(async () => {
            aggregate = session.read();
            const next = transitionTask(
              aggregate,
              reviewTask.id,
              { status },
              aggregate.revision,
              clock.now(),
              runtime,
            );
            aggregate = await commitUpdate(session, aggregate, next);
          }),
        fail: (status, failure) =>
          serializeFailureOperation(async () => {
            aggregate = session.read();
            const next = transitionTask(
              aggregate,
              reviewTask.id,
              { status, error: failure },
              aggregate.revision,
              clock.now(),
              runtime,
            );
            aggregate = await commitUpdate(session, aggregate, next);
          }),
        arbitrateTask: (command) =>
          serializeFailureOperation(() => {
            if (command.kind === 'save') savingArbitrationCalls += 1;
            return Promise.reject(new Error('failure must not enter arbitration'));
          }),
      };
      const failedExecution = new AiTaskCoordinator({
        runner: new ImmediateRunner(failure.source),
      }).execute({
        taskId: reviewTask.id,
        input: {
          model: 'deepseek-v4-pro',
          messages: [{ role: 'user', content: reviewPromptText }],
          reasoningEffort: 'medium',
          maxWords: 900,
        },
        apiKey: 'integration-test-credential',
        requestTimeoutMs: 10_000,
        contentAcceptance: domainContentAcceptance,
        port: failurePort,
      });
      await expect(failedExecution.outcome).resolves.toMatchObject({
        status: 'failed',
        error: { code: failure.expectedCode },
      });
      expect(aggregate.versions).toHaveLength(1);
      expect(aggregate.latestVersionId).toBe(proposedVersionId);
      expect(aggregate.versions[0]?.contentRef.sha256).toBe(originalVersionHash);
      expect(savingArbitrationCalls).toBe(0);
    }

    const runControlledTerminal = async (terminal: 'cancelled' | 'timedOut'): Promise<void> => {
      const promptText = `Controlled ${terminal} case.`;
      const promptRef = artifact(`content/prompts/${ids.peek(1)}/0.txt`, promptText, 'text/plain');
      const queued = queueTask(
        aggregate,
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
              model: 'deepseek-v4-pro',
              reasoningEffort: 'medium',
              targetChannel: '学院网站',
              maxWords: 900,
              requestTimeoutMs: 10_000,
            },
          },
        },
        aggregate.revision,
        { ids, clock, runtime },
      );
      aggregate = await commitUpdate(
        session,
        aggregate,
        queued,
        new Map([[promptRef.relativePath, promptText]]),
      );
      const controlledTask = aggregate.tasks.at(-1);
      if (controlledTask === undefined) throw new Error('missing controlled task');
      let resolvePreparing!: () => void;
      const preparingCommitted = new Promise<void>((resolve) => {
        resolvePreparing = resolve;
      });
      const serializeControlledOperation = createSerialExecutor();
      const controlledPort: TaskExecutionPort = {
        transition: (status) =>
          serializeControlledOperation(async () => {
            aggregate = session.read();
            const next = transitionTask(
              aggregate,
              controlledTask.id,
              { status },
              aggregate.revision,
              clock.now(),
              runtime,
            );
            aggregate = await commitUpdate(session, aggregate, next);
            if (status === 'preparing') resolvePreparing();
          }),
        fail: (status, error) =>
          serializeControlledOperation(async () => {
            aggregate = session.read();
            const next = transitionTask(
              aggregate,
              controlledTask.id,
              { status, error },
              aggregate.revision,
              clock.now(),
              runtime,
            );
            aggregate = await commitUpdate(session, aggregate, next);
          }),
        arbitrateTask: (command) =>
          serializeControlledOperation(async () => {
            aggregate = session.read();
            const persistedTask = aggregate.tasks.find(
              (candidate) => candidate.id === controlledTask.id,
            );
            if (persistedTask === undefined) return 'conflict';
            if (persistedTask.status === 'saving' || persistedTask.status === 'succeeded') {
              return 'saving';
            }
            if (persistedTask.status === 'cancelled' || persistedTask.status === 'timedOut') {
              return persistedTask.status;
            }
            if (command.kind === 'save') {
              throw new Error('terminal task must not save');
            }
            const winner = command.kind === 'cancel' ? 'cancelled' : 'timedOut';
            const next = transitionTask(
              aggregate,
              controlledTask.id,
              { status: winner, error: command.error },
              aggregate.revision,
              clock.now(),
              runtime,
            );
            aggregate = await commitUpdate(session, aggregate, next);
            return winner;
          }),
      };
      const timer = new ManualTimer();
      const pendingRunner = new PendingRunner();
      const execution = new AiTaskCoordinator({
        runner: pendingRunner,
        timer,
      }).execute({
        taskId: controlledTask.id,
        input: {
          model: 'deepseek-v4-pro',
          messages: [{ role: 'user', content: promptText }],
          reasoningEffort: 'medium',
          maxWords: 900,
        },
        apiKey: 'integration-test-credential',
        requestTimeoutMs: 1_000,
        contentAcceptance: domainContentAcceptance,
        port: controlledPort,
      });
      if (terminal === 'cancelled') await expect(execution.cancel()).resolves.toBe('accepted');
      else {
        await preparingCommitted;
        await pendingRunner.started;
        timer.fire();
      }
      await expect(execution.outcome).resolves.toMatchObject({ status: terminal });
      expect(aggregate.versions).toHaveLength(1);
      expect(aggregate.latestVersionId).toBe(proposedVersionId);
      expect(aggregate.versions[0]?.contentRef.sha256).toBe(originalVersionHash);
    };

    await runControlledTerminal('cancelled');
    await runControlledTerminal('timedOut');
    await session.close();
  }, 180_000);
});

const commitUpdate = async (
  session: ProjectSession,
  current: ProjectAggregateV1,
  next: ProjectAggregateV1,
  artifacts = new Map<string, string>(),
): Promise<ProjectAggregateV1> =>
  await session.commit({
    transactionId: makeTransactionId(),
    commitId: makeCommitId(),
    expectedRevision: current.revision,
    expectedHeadCommitId: session.headCommitId,
    nextAggregate: next,
    artifacts,
  });
