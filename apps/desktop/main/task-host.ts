import { createHash, randomUUID } from 'node:crypto';

import {
  AiSafeError,
  AiTaskCoordinator,
  deepSeekModelSchema,
  makeSafeError,
  type ChatCompletionResult,
  type TaskArbitrationWinner,
  type TaskExecution,
  type TaskExecutionPort,
  type WorkerRunner,
} from '@news-writer/ai';
import {
  checkMissingFacts,
  commitSuccessfulVersion,
  fingerprintCommentSnapshot,
  queueTask,
  resolveBranchFacts,
  resolveFactOverrides,
  transitionTask,
  validateNewsContent,
  type ProjectAggregateV1,
} from '@news-writer/domain';
import { makeCommitId, makeTransactionId, type ProjectSession } from '@news-writer/project';
import {
  projectRelativePathSchema,
  sha256Schema,
  systemClock,
  textArtifactRefSchema,
  timestampSchema,
  versionIdSchema,
  type IdGenerator,
  type RuntimeVersionSnapshot,
  type SafeAppError,
  type TaskId,
  type TextArtifactRef,
} from '@news-writer/shared';
import { containsSecretMaterial } from '@news-writer/shared';
import {
  taskStatusEventDtoSchema,
  type CancelTaskDto,
  type CancelTaskResultDto,
  type SessionId,
  type StartTaskDto,
  type TaskStatusEventDto,
  type TaskViewDto,
} from '@news-writer/shared/ipc';

import type { CredentialService } from './credential-service.js';
import { SafeMainError } from './ipc-core.js';
import { SerialLinearizationGate, type LinearizationGate } from './linearization.js';
import type { ProjectService } from './project-service.js';

interface ActiveHost {
  sessionId: SessionId;
  ownerId: number;
  taskId: TaskId;
  execution: TaskExecution;
  cancel: () => Promise<CancelTaskResultDto['disposition']>;
  settled: Promise<void>;
}

const artifact = (relativePath: string, content: string): TextArtifactRef => {
  const bytes = Buffer.from(content, 'utf8');
  return textArtifactRefSchema.parse({
    relativePath: projectRelativePathSchema.parse(relativePath),
    sha256: sha256Schema.parse(createHash('sha256').update(bytes).digest('hex')),
    byteLength: bytes.byteLength,
    mediaType: relativePath.endsWith('.md') ? 'text/markdown' : 'text/plain',
    encoding: 'utf-8',
  });
};

const serialize = () => {
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

export class TaskHostService {
  readonly #projects: ProjectService;
  readonly #credentials: Pick<CredentialService, 'readApiKey'>;
  readonly #runtime: RuntimeVersionSnapshot;
  readonly #workerRunner: WorkerRunner;
  readonly #onUnrecoverable: (error: unknown) => void | Promise<void>;
  readonly #gate: LinearizationGate;
  readonly #active = new Map<SessionId, ActiveHost>();
  readonly #listeners = new Map<number, (event: TaskStatusEventDto) => void>();

  constructor(
    projects: ProjectService,
    credentials: Pick<CredentialService, 'readApiKey'>,
    runtime: RuntimeVersionSnapshot,
    workerRunner: WorkerRunner,
    onUnrecoverable: (error: unknown) => void | Promise<void> = () => undefined,
    gate: LinearizationGate = new SerialLinearizationGate(),
  ) {
    this.#projects = projects;
    this.#credentials = credentials;
    this.#runtime = runtime;
    this.#workerRunner = workerRunner;
    this.#onUnrecoverable = onUnrecoverable;
    this.#gate = gate;
  }

  setListener(ownerId: number, listener: ((event: TaskStatusEventDto) => void) | undefined): void {
    if (listener === undefined) this.#listeners.delete(ownerId);
    else this.#listeners.set(ownerId, listener);
  }

  async start(input: StartTaskDto, ownerId: number): Promise<TaskViewDto> {
    return await this.#gate.run(async () => await this.#startWithinGate(input, ownerId));
  }

  async #startWithinGate(input: StartTaskDto, ownerId: number): Promise<TaskViewDto> {
    if (this.#active.has(input.sessionId))
      throw new SafeMainError(this.#stateConflict('Another task is active'));
    const owned = this.#projects.getOwned(input.sessionId, ownerId);
    if (owned.aggregate.revision !== input.expectedRevision)
      throw new SafeMainError(this.#conflict());
    if (owned.aggregate.latestVersionId !== input.parentVersionId) {
      throw new SafeMainError(
        this.#stateConflict('The selected parent version is not the current latest version'),
      );
    }
    const prepared = await this.#projects.preparePromptWithinGate(
      {
        sessionId: input.sessionId,
        expectedRevision: input.expectedRevision,
        kind: input.kind,
        parentVersionId: input.parentVersionId,
        ...(input.retrievalEnabled === undefined
          ? {}
          : { retrievalEnabled: input.retrievalEnabled }),
        ...(input.retrievalReportId === undefined
          ? {}
          : { retrievalReportId: input.retrievalReportId }),
        ...(input.factOverrides === undefined ? {} : { factOverrides: input.factOverrides }),
        ...(input.taskConfig === undefined ? {} : { taskConfig: input.taskConfig }),
      },
      ownerId,
    );
    const currentFingerprint = prepared.inputFingerprint;
    const upstream = {
      promptInputFingerprint: input.promptInputFingerprint,
      currentInputFingerprint: currentFingerprint,
      staleResolution: input.staleResolution,
      ...(input.previousPromptInputFingerprint === undefined
        ? {}
        : { previousPromptInputFingerprint: input.previousPromptInputFingerprint }),
    } as const;
    const staleValid =
      (input.staleResolution === 'current' &&
        input.promptInputFingerprint === currentFingerprint &&
        input.previousPromptInputFingerprint === undefined) ||
      (input.staleResolution === 'continued' &&
        input.promptInputFingerprint !== currentFingerprint &&
        input.previousPromptInputFingerprint === undefined) ||
      (input.staleResolution === 'regenerated' &&
        input.promptInputFingerprint === currentFingerprint &&
        input.previousPromptInputFingerprint !== undefined &&
        input.previousPromptInputFingerprint !== currentFingerprint);
    if (!staleValid) {
      throw new SafeMainError(this.#conflict());
    }
    if (
      !input.editedByUser &&
      JSON.stringify(input.messages) !== JSON.stringify(prepared.messages)
    ) {
      throw new SafeMainError(this.#protocolInvalid('The unedited Prompt does not match preview'));
    }
    const acknowledged = new Set(input.acknowledgedRiskCodes);
    if (prepared.risks.some((risk) => !acknowledged.has(risk.code))) {
      throw new SafeMainError(
        this.#stateConflict('Blocking Prompt risks require explicit confirmation'),
      );
    }
    const supportedModel = deepSeekModelSchema.safeParse(prepared.resolvedConfig.values.model);
    if (!supportedModel.success) {
      throw new SafeMainError(
        this.#protocolInvalid('The configured DeepSeek model is not supported'),
      );
    }
    const apiKey = await this.#credentials.readApiKey();
    if (
      containsSecretMaterial(
        input.messages.map((message) => message.content),
        [apiKey],
      )
    ) {
      throw new SafeMainError(
        this.#contentInvalid('The Prompt appears to contain credential material'),
      );
    }

    const promptId = randomUUID();
    const taskId = randomUUID();
    const generated = [promptId, taskId];
    const taskIds: IdGenerator = {
      next: () => {
        const value = generated.shift();
        if (value === undefined) throw new Error('task ID sequence exhausted');
        return value;
      },
    };
    const promptArtifacts = new Map<string, string>();
    const messageRefs = input.messages.map((message, index) => {
      const ref = artifact(`content/prompts/${taskId}/${index}.txt`, message.content);
      promptArtifacts.set(ref.relativePath, message.content);
      return { role: message.role, contentRef: ref };
    });
    const userConfig = await this.#projects.readUserConfigWithinGate();
    const branchFacts = resolveBranchFacts(owned.aggregate, input.parentVersionId);
    const factOverrides = resolveFactOverrides(branchFacts.factOverrides, input.factOverrides);
    const queuedAt = systemClock.now();
    const queued = queueTask(
      owned.aggregate,
      {
        kind: input.kind,
        messages: messageRefs,
        editedByUser: input.editedByUser,
        ...(input.editedByUser ? { editWarningAcknowledgedAt: queuedAt } : {}),
        upstream,
        config: {
          defaults: this.#projects.readDefaultGenerationConfig(owned.aggregate.profile),
          ...(Object.keys(userConfig.config).length === 0 ? {} : { user: userConfig.config }),
          ...(input.taskConfig === undefined ? {} : { task: input.taskConfig }),
        },
        ...(factOverrides === undefined ? {} : { factOverrides }),
        ...(prepared.trace.retrieval.state === 'used' ||
        prepared.trace.retrieval.state === 'zeroHits'
          ? { retrievalReportId: prepared.trace.retrieval.reportId }
          : {}),
        ...(prepared.trace.retrieval.state === 'unavailable' ? { retrievalUnavailable: true } : {}),
        ...(prepared.trace.profileSnapshot === undefined
          ? {}
          : { profileSnapshot: prepared.trace.profileSnapshot }),
        reviewEnabled: input.reviewEnabled ?? false,
      },
      input.expectedRevision,
      {
        ids: taskIds,
        clock: { now: () => queuedAt },
        runtime: this.#runtime,
      },
    );
    const queuedTask = queued.tasks.at(-1);
    if (queuedTask === undefined)
      throw new SafeMainError(this.#stateConflict('The task could not be queued'));
    const model = supportedModel.data;
    await owned.project.commit({
      transactionId: makeTransactionId(),
      commitId: makeCommitId(),
      expectedRevision: input.expectedRevision,
      expectedHeadCommitId: owned.project.headCommitId,
      nextAggregate: queued,
      artifacts: promptArtifacts,
    });
    this.#emit(input.sessionId, ownerId, queuedTask.id);

    const hostSerial = serialize();
    const proposedVersionId = versionIdSchema.parse(randomUUID());
    const successTransactionId = makeTransactionId();
    const port = this.#port(
      owned.project,
      input.sessionId,
      ownerId,
      queuedTask.id,
      proposedVersionId,
      successTransactionId,
      hostSerial,
      { deferSave: input.reviewEnabled === true },
    );
    const coordinator = new AiTaskCoordinator({
      runner: this.#workerRunner,
    });
    const execution = coordinator.execute({
      taskId: queuedTask.id,
      input: {
        model,
        messages: input.messages,
        reasoningEffort: queuedTask.configSnapshot.values.reasoningEffort,
        maxWords: queuedTask.configSnapshot.values.maxWords,
      },
      apiKey,
      requestTimeoutMs: queuedTask.configSnapshot.values.requestTimeoutMs,
      contentAcceptance: {
        accept: (result) => {
          const validation = validateNewsContent(result.content);
          if (!validation.accepted) {
            throw new AiSafeError(
              makeSafeError(
                validation.reason === 'empty' ? 'EMPTY_RESPONSE' : 'CONTENT_INVALID',
                'The response is not a clean news article',
              ),
            );
          }
          return Promise.resolve({ ...result, content: validation.content });
        },
      },
      port,
    });
    const active: ActiveHost = {
      sessionId: input.sessionId,
      ownerId,
      taskId: queuedTask.id,
      execution,
      cancel: async () => await execution.cancel(),
      settled: Promise.resolve(),
    };
    active.settled = execution.outcome
      .then(async (outcome) => {
        if (outcome.status === 'saving') {
          await hostSerial(async () => {
            if (queuedTask.reviewEnabled) {
              await this.#runReview(
                owned.project,
                input.sessionId,
                ownerId,
                queuedTask.id,
                proposedVersionId,
                successTransactionId,
                outcome.result,
                active,
              );
            } else {
              await this.#complete(
                owned.project,
                queuedTask.id,
                proposedVersionId,
                successTransactionId,
                outcome.result,
              );
            }
          });
        }
        return this.#isTerminal(owned.project.read(), queuedTask.id);
      })
      .catch(
        async (error) =>
          await hostSerial(
            async () => await this.#reconcileCompletion(owned.project, queuedTask.id, error),
          ),
      )
      .then((terminal) => {
        if (terminal && this.#active.get(input.sessionId) === active) {
          this.#active.delete(input.sessionId);
        }
        this.#emit(input.sessionId, ownerId, queuedTask.id);
      });
    this.#active.set(input.sessionId, active);
    return this.#taskView(owned.project.read(), queuedTask.id);
  }

  async cancel(input: CancelTaskDto, ownerId: number): Promise<CancelTaskResultDto> {
    const owned = this.#projects.getOwned(input.sessionId, ownerId);
    if (owned.aggregate.revision !== input.expectedRevision)
      throw new SafeMainError(this.#conflict());
    if (!owned.aggregate.tasks.some((task) => task.id === input.taskId))
      throw new SafeMainError(this.#notFound());
    const active = this.#active.get(input.sessionId);
    if (active === undefined || active.ownerId !== ownerId || active.taskId !== input.taskId) {
      return { disposition: 'savingOrFinished' };
    }
    return { disposition: await active.cancel() };
  }

  async shutdownAll(): Promise<void> {
    const active = [...this.#active.values()];
    await Promise.all(active.map(async (host) => await host.cancel().catch(() => undefined)));
    await Promise.allSettled(active.map(async (host) => await host.settled));
  }

  async #reconcileCompletion(
    project: ProjectSession,
    taskId: TaskId,
    originalError: unknown,
  ): Promise<boolean> {
    try {
      return await this.#gate.run(async () => {
        let current = await project.refresh();
        if (this.#isTerminal(current, taskId)) return true;
        const interrupted = current.tasks.find((task) => task.id === taskId);
        if (interrupted === undefined) throw originalError;
        const error =
          originalError instanceof SafeMainError && originalError.safe.code === 'CONTENT_INVALID'
            ? originalError.safe
            : makeSafeError('TASK_INTERRUPTED', 'The task stopped unexpectedly', {
                retryable: true,
              });
        const next = transitionTask(
          current,
          taskId,
          { status: 'failed', error },
          current.revision,
          error.occurredAt,
          this.#runtime,
        );
        try {
          await project.commit({
            transactionId: makeTransactionId(),
            commitId: makeCommitId(),
            expectedRevision: current.revision,
            expectedHeadCommitId: project.headCommitId,
            nextAggregate: next,
          });
        } catch {
          // The commit may have crossed its atomic head replacement before reporting failure.
        }
        current = await project.refresh();
        if (!this.#isTerminal(current, taskId)) throw originalError;
        return true;
      });
    } catch (error) {
      await Promise.resolve(this.#onUnrecoverable(error)).catch(() => undefined);
      return false;
    }
  }

  #isTerminal(project: ProjectAggregateV1, taskId: TaskId): boolean {
    const status = project.tasks.find((task) => task.id === taskId)?.status;
    return (
      status === 'succeeded' ||
      status === 'failed' ||
      status === 'cancelled' ||
      status === 'timedOut'
    );
  }

  #port(
    project: ProjectSession,
    sessionId: SessionId,
    ownerId: number,
    taskId: TaskId,
    proposedVersionId: ReturnType<typeof versionIdSchema.parse>,
    successTransactionId: ReturnType<typeof makeTransactionId>,
    hostSerial: ReturnType<typeof serialize>,
    options: { deferSave?: boolean; reviewMode?: boolean } = {},
  ): TaskExecutionPort {
    const commitTransitionWithinGate = async (
      payload: Parameters<typeof transitionTask>[2],
    ): Promise<ProjectAggregateV1> => {
      const current = project.read();
      const next = transitionTask(
        current,
        taskId,
        payload,
        current.revision,
        systemClock.now(),
        this.#runtime,
      );
      const committed = await project.commit({
        transactionId: makeTransactionId(),
        commitId: makeCommitId(),
        expectedRevision: current.revision,
        expectedHeadCommitId: project.headCommitId,
        nextAggregate: next,
      });
      this.#emit(sessionId, ownerId, taskId);
      return committed;
    };
    const commitTransition = async (
      payload: Parameters<typeof transitionTask>[2],
    ): Promise<ProjectAggregateV1> =>
      await this.#gate.run(async () => await commitTransitionWithinGate(payload));
    return {
      transition: async (status) => {
        if (options.reviewMode) return;
        await hostSerial(async () => {
          await commitTransition({ status });
        });
      },
      fail: async (_status, error) => {
        await hostSerial(async () => {
          await commitTransition({ status: 'failed', error });
        });
      },
      arbitrateTask: async (command): Promise<TaskArbitrationWinner> =>
        await hostSerial(async () => {
          return await this.#gate.run(async () => {
            const current = project.read();
            const task = current.tasks.find((candidate) => candidate.id === taskId);
            if (task === undefined) return 'conflict';
            if (task.status === 'saving' || task.status === 'succeeded') return 'saving';
            if (task.status === 'cancelled' || task.status === 'timedOut') return task.status;
            if (task.status === 'failed') return 'conflict';
            if (command.kind === 'save') {
              if (options.deferSave) {
                await commitTransitionWithinGate({ status: 'reviewing' });
                return 'saving';
              }
              await commitTransitionWithinGate({
                status: 'saving',
                successTransactionId,
                proposedVersionId,
              });
              return 'saving';
            }
            await commitTransitionWithinGate({
              status: command.kind === 'cancel' ? 'cancelled' : 'timedOut',
              error: command.error,
            });
            return command.kind === 'cancel' ? 'cancelled' : 'timedOut';
          });
        }),
    };
  }

  async #runReview(
    project: ProjectSession,
    sessionId: SessionId,
    ownerId: number,
    taskId: TaskId,
    proposedVersionId: ReturnType<typeof versionIdSchema.parse>,
    successTransactionId: ReturnType<typeof makeTransactionId>,
    firstResult: ChatCompletionResult,
    active: ActiveHost,
  ): Promise<void> {
    const current = project.read();
    const task = current.tasks.find((candidate) => candidate.id === taskId);
    if (task?.status !== 'reviewing') return;
    const minutes = project.readText(task.minutesSnapshot.contentRef);
    const factOverrides = task.factOverrides;
    const escapePromptMaterial = (value: string): string =>
      value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const overrideLines = factOverrides
      ? Object.entries(factOverrides).flatMap(([field, value]) => {
          const labels: Record<string, string> = {
            date: '日期',
            time: '时间',
            location: '地点',
            organizer: '活动主办/组织方',
          };
          if (value === undefined) return [];
          return [
            value.mode === 'manual'
              ? `- ${labels[field] ?? field}：用户确认值“${escapePromptMaterial(value.value)}”`
              : value.mode === 'none'
                ? `- ${labels[field] ?? field}：用户确认未提供`
                : `- ${labels[field] ?? field}：继续自动识别`,
          ];
        })
      : [];
    const hasFactOverrides = factOverrides !== undefined && Object.keys(factOverrides).length > 0;
    const reviewFacts = checkMissingFacts({
      minutes,
      ...(factOverrides === undefined ? {} : { factOverrides }),
    });
    const factBoundary = hasFactOverrides
      ? '活动纪要和用户事实检查确认共同构成本轮事实来源；标记为“用户确认”的手动值必须按原文使用；“用户确认未提供”表示不得补写该字段；自动识别结果仍须以活动纪要为准。'
      : '';
    const dateOutput = hasFactOverrides
      ? reviewFacts.date.evidence === undefined
        ? '如事实来源未提供日期，省略日期落款，不输出“日期未提供”等占位文字。'
        : `正文后输出日期“${escapePromptMaterial(reviewFacts.date.evidence)}”。`
      : '';
    const reviewPrompt = [
      '# 任务',
      '校核并修订下面的新闻稿初稿。',
      '',
      '# 审稿规范',
      `检查事实边界、标题、语言、中文标点和新闻稿结构。${factBoundary || '活动纪要是唯一事实来源。'} 删除无法由来源支持的细节。只输出完整新闻稿，不输出审稿意见或修改说明。`,
      '',
      '# 活动纪要',
      '<minutes>',
      minutes.trimEnd(),
      '</minutes>',
      '',
      '# 用户事实检查确认',
      ...(overrideLines.length > 0 ? overrideLines : ['本次未修改自动事实检查结果。']),
      '',
      '# 待审新闻稿',
      '<draft>',
      firstResult.content.trimEnd(),
      '</draft>',
      '',
      '# 输出要求',
      `第一非空行只写标题，随后输出正文和落款主体${dateOutput ? `；${dateOutput}` : '及日期'}；不得输出解释、分析、问题清单或内部处理过程。`,
    ].join('\n');
    const apiKey = await this.#credentials.readApiKey();
    if (containsSecretMaterial([reviewPrompt], [apiKey])) {
      throw new SafeMainError(
        this.#contentInvalid('The review Prompt contains credential material'),
      );
    }
    const coordinator = new AiTaskCoordinator({ runner: this.#workerRunner });
    const execution = coordinator.execute({
      taskId,
      input: {
        model: deepSeekModelSchema.parse(task.configSnapshot.values.model),
        messages: [{ role: 'user', content: reviewPrompt }],
        reasoningEffort: task.configSnapshot.values.reasoningEffort,
        maxWords: task.configSnapshot.values.maxWords,
      },
      apiKey,
      requestTimeoutMs: task.configSnapshot.values.requestTimeoutMs,
      contentAcceptance: {
        accept: (result) => {
          const validation = validateNewsContent(result.content);
          if (!validation.accepted)
            throw new AiSafeError(
              makeSafeError(
                validation.reason === 'empty' ? 'EMPTY_RESPONSE' : 'CONTENT_INVALID',
                'The review response is not a clean news article',
              ),
            );
          return Promise.resolve({ ...result, content: validation.content });
        },
      },
      port: this.#port(
        project,
        sessionId,
        ownerId,
        taskId,
        proposedVersionId,
        successTransactionId,
        serialize(),
        { reviewMode: true },
      ),
    });
    active.execution = execution;
    active.cancel = async () => await execution.cancel();
    const outcome = await execution.outcome;
    if (outcome.status === 'saving')
      await this.#complete(
        project,
        taskId,
        proposedVersionId,
        successTransactionId,
        outcome.result,
      );
  }

  async #complete(
    project: ProjectSession,
    taskId: TaskId,
    proposedVersionId: ReturnType<typeof versionIdSchema.parse>,
    successTransactionId: ReturnType<typeof makeTransactionId>,
    result: ChatCompletionResult,
  ): Promise<void> {
    await this.#gate.run(
      async () =>
        await this.#completeWithinGate(
          project,
          taskId,
          proposedVersionId,
          successTransactionId,
          result,
        ),
    );
  }

  async #completeWithinGate(
    project: ProjectSession,
    taskId: TaskId,
    proposedVersionId: ReturnType<typeof versionIdSchema.parse>,
    successTransactionId: ReturnType<typeof makeTransactionId>,
    result: ChatCompletionResult,
  ): Promise<void> {
    const current = project.read();
    const savingTask = current.tasks.find((task) => task.id === taskId);
    if (savingTask?.status !== 'saving') return;
    const currentApiKey = await this.#credentials.readApiKey();
    if (containsSecretMaterial([JSON.stringify(current), result.content], [currentApiKey])) {
      throw new SafeMainError(
        this.#contentInvalid('The generated content appears to contain credential material'),
      );
    }
    const contentRef = artifact(`content/versions/${proposedVersionId}.md`, result.content);
    const completedAt = systemClock.now();
    const next = commitSuccessfulVersion(
      current,
      { taskId, contentRef, createdAt: completedAt },
      current.revision,
      {
        readText: (ref) =>
          ref.relativePath === contentRef.relativePath ? result.content : project.readText(ref),
      },
      this.#runtime,
    );
    await project.commit({
      transactionId: successTransactionId,
      commitId: makeCommitId(),
      expectedRevision: current.revision,
      expectedHeadCommitId: project.headCommitId,
      operation: 'completeTaskWithVersion',
      details: {
        operation: 'completeTaskWithVersion',
        successTransactionId,
        taskId,
        fromTaskSequence: savingTask.sequence,
        toTaskSequence: savingTask.sequence + 1,
        versionId: proposedVersionId,
        baseRevision: current.revision,
        revision: current.revision + 1,
      },
      nextAggregate: next,
      artifacts: new Map([[contentRef.relativePath, result.content]]),
    });
  }

  #emit(sessionId: SessionId, ownerId: number, taskId: TaskId): void {
    const listener = this.#listeners.get(ownerId);
    if (listener === undefined) return;
    try {
      const task = this.#projects
        .getOwned(sessionId, ownerId)
        .aggregate.tasks.find((candidate) => candidate.id === taskId);
      if (task === undefined) return;
      const active = this.#active.get(sessionId);
      if (this.#isTerminalStatus(task.status) && active?.taskId === taskId) return;
      listener(
        taskStatusEventDtoSchema.parse({
          sessionId,
          taskId,
          status: task.status,
          occurredAt: task.updatedAt,
          ...('error' in task ? { error: task.error } : {}),
        }),
      );
    } catch {
      return;
    }
  }

  #taskView(project: ProjectAggregateV1, taskId: TaskId): TaskViewDto {
    const task = project.tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) throw new SafeMainError(this.#notFound());
    return {
      id: task.id,
      kind: task.kind,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      parentVersionId: task.parentVersionId,
      promptId: task.promptId,
      history: task.history,
      configSnapshot: task.configSnapshot,
      minutes: {
        revisionId: task.minutesSnapshot.revisionId,
        sha256: task.minutesSnapshot.contentRef.sha256,
      },
      factOverrides: task.factOverrides,
      retrieval: (() => {
        if (task.retrievalReportId === undefined)
          return {
            state:
              task.retrievalUnavailable === true ? ('unavailable' as const) : ('notUsed' as const),
          };
        const report = project.retrievalReports.find(
          (candidate) => candidate.id === task.retrievalReportId,
        );
        if (report === undefined) return { state: 'unavailable' as const };
        return {
          state: report.hits.length === 0 ? ('zeroHits' as const) : ('used' as const),
          reportId: report.id,
          knowledgeVersion: report.knowledgeVersion,
          hitCount: report.hits.length,
        };
      })(),
      comments: {
        count: task.commentSnapshot.length,
        sha256: fingerprintCommentSnapshot(
          task.commentSnapshot.map((comment) => ({
            anchor: comment.anchor,
            id: comment.id,
            createdAt: comment.createdAt,
            quotedText: comment.quotedText,
            body: comment.body,
          })),
          {
            sha256Utf8: (text) =>
              sha256Schema.parse(createHash('sha256').update(text, 'utf8').digest('hex')),
          },
        ),
      },
      reviewEnabled: task.reviewEnabled === true,
      ...('resultVersionId' in task ? { resultVersionId: task.resultVersionId } : {}),
      ...('error' in task ? { error: task.error } : {}),
    };
  }

  #isTerminalStatus(status: ProjectAggregateV1['tasks'][number]['status']): boolean {
    return (
      status === 'succeeded' ||
      status === 'failed' ||
      status === 'cancelled' ||
      status === 'timedOut'
    );
  }

  #safe(
    code:
      'IPC_PROTOCOL_INVALID' | 'PROJECT_CONFLICT' | 'PROJECT_NOT_FOUND' | 'PROJECT_STATE_CONFLICT',
    safeMessage: string,
  ): SafeAppError {
    return {
      code,
      occurredAt: timestampSchema.parse(new Date().toISOString()),
      safeMessage,
      retryable: false,
    };
  }
  #protocolInvalid(message: string) {
    return this.#safe('IPC_PROTOCOL_INVALID', message);
  }
  #contentInvalid(message: string) {
    return {
      code: 'CONTENT_INVALID' as const,
      occurredAt: timestampSchema.parse(new Date().toISOString()),
      safeMessage: message,
      retryable: false,
    };
  }
  #conflict() {
    return this.#safe('PROJECT_CONFLICT', 'The project changed before the task request');
  }
  #notFound() {
    return this.#safe('PROJECT_NOT_FOUND', 'The requested task was not found');
  }
  #stateConflict(message: string) {
    return this.#safe('PROJECT_STATE_CONFLICT', message);
  }
}
