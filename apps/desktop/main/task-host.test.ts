import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  ChatCompletionInput,
  ChatCompletionResult,
  WorkerRun,
  WorkerRunner,
} from '@news-writer/ai';
import { AiSafeError, makeSafeError } from '@news-writer/ai';
import { DEFAULT_GENERATION_CONFIG, recordRetrieval } from '@news-writer/domain';
import { makeCommitId, makeTransactionId } from '@news-writer/project';
import {
  retrievalReportIdSchema,
  sha256Schema,
  systemClock,
  versionIdSchema,
  type TaskId,
} from '@news-writer/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { setCommitBarrierForTest } from '../../../packages/project/dist/faults.js';

import { ProjectService, type ProjectUserConfigPort } from './project-service.js';
import { SerialLinearizationGate, type LinearizationGate } from './linearization.js';
import { runWithWatchdog, type WatchdogTimerPort } from './shutdown.js';
import { TaskHostService } from './task-host.js';

const roots: string[] = [];
afterEach(async () => {
  setCommitBarrierForTest();
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

class ImmediateRunner implements WorkerRunner {
  starts = 0;
  lastInput: ChatCompletionInput | undefined;
  constructor(readonly response: ChatCompletionResult) {}
  run(
    _taskId: TaskId,
    input: ChatCompletionInput,
    _apiKey: string,
    onStatus: (status: 'requesting' | 'processing') => void,
  ): WorkerRun {
    this.starts += 1;
    this.lastInput = input;
    onStatus('requesting');
    onStatus('processing');
    return {
      result: Promise.resolve(this.response),
      cancel: () => undefined,
      shutdown: async () => undefined,
      terminate: async () => 0,
    };
  }
}

class PendingRunner implements WorkerRunner {
  starts = 0;
  readonly started: Promise<void>;
  #resolveStarted!: () => void;
  constructor() {
    this.started = new Promise((resolve) => {
      this.#resolveStarted = resolve;
    });
  }
  run(
    _taskId: TaskId,
    _input: ChatCompletionInput,
    _apiKey: string,
    onStatus: (status: 'requesting' | 'processing') => void,
  ): WorkerRun {
    this.starts += 1;
    this.#resolveStarted();
    onStatus('requesting');
    return {
      result: new Promise(() => undefined),
      cancel: () => undefined,
      shutdown: async () => undefined,
      terminate: async () => 0,
    };
  }
}

class FailingRunner implements WorkerRunner {
  run(): WorkerRun {
    return {
      result: Promise.reject(
        new AiSafeError(makeSafeError('SERVICE_UNAVAILABLE', 'Synthetic service failure')),
      ),
      cancel: () => undefined,
      shutdown: async () => undefined,
      terminate: async () => 0,
    };
  }
}

class SafeFailingRunner implements WorkerRunner {
  starts = 0;
  constructor(readonly error: ReturnType<typeof makeSafeError>) {}

  run(): WorkerRun {
    this.starts += 1;
    return {
      result: Promise.reject(new AiSafeError(this.error)),
      cancel: () => undefined,
      shutdown: async () => undefined,
      terminate: async () => 0,
    };
  }
}

class ForgedStatusRunner implements WorkerRunner {
  run(
    _taskId: TaskId,
    _input: ChatCompletionInput,
    _apiKey: string,
    onStatus: (status: 'requesting' | 'processing') => void,
  ): WorkerRun {
    onStatus('forged' as never);
    return {
      result: new Promise(() => undefined),
      cancel: () => undefined,
      shutdown: async () => undefined,
      terminate: async () => 0,
    };
  }
}

class DeferredSuccessRunner implements WorkerRunner {
  readonly started: Promise<void>;
  #resolveStarted!: () => void;
  #resolveResult!: (result: ChatCompletionResult) => void;
  readonly result: Promise<ChatCompletionResult>;

  constructor() {
    this.started = new Promise((resolve) => {
      this.#resolveStarted = resolve;
    });
    this.result = new Promise((resolve) => {
      this.#resolveResult = resolve;
    });
  }

  complete(): void {
    this.#resolveResult({
      id: 'deferred-response',
      model: 'deepseek-v4-pro',
      content: '合成活动圆满结束\n参与人员围绕主题进行了充分交流。',
      finishReason: 'stop',
    });
  }

  run(
    _taskId: TaskId,
    _input: ChatCompletionInput,
    _apiKey: string,
    onStatus: (status: 'requesting' | 'processing') => void,
  ): WorkerRun {
    this.#resolveStarted();
    onStatus('requesting');
    onStatus('processing');
    return {
      result: this.result,
      cancel: () => undefined,
      shutdown: () => Promise.resolve(),
      terminate: () => Promise.resolve(0),
    };
  }
}

class SequenceRunner implements WorkerRunner {
  constructor(readonly runners: WorkerRunner[]) {}

  run(
    taskId: TaskId,
    input: ChatCompletionInput,
    apiKey: string,
    onStatus: (status: 'requesting' | 'processing') => void,
  ): WorkerRun {
    const runner = this.runners.shift();
    if (runner === undefined) throw new Error('runner sequence exhausted');
    return runner.run(taskId, input, apiKey, onStatus);
  }
}

class DeferredCredentialRunner implements WorkerRunner {
  readonly started: Promise<void>;
  #resolveStarted!: () => void;
  #resolveResult!: (result: ChatCompletionResult) => void;
  readonly result: Promise<ChatCompletionResult>;

  constructor() {
    this.started = new Promise((resolve) => {
      this.#resolveStarted = resolve;
    });
    this.result = new Promise((resolve) => {
      this.#resolveResult = resolve;
    });
  }

  complete(content: string): void {
    this.#resolveResult({
      id: 'credential-race-response',
      model: 'deepseek-v4-pro',
      content,
      finishReason: 'stop',
    });
  }

  run(
    _taskId: TaskId,
    _input: ChatCompletionInput,
    _apiKey: string,
    onStatus: (status: 'requesting' | 'processing') => void,
  ): WorkerRun {
    this.#resolveStarted();
    onStatus('requesting');
    onStatus('processing');
    return {
      result: this.result,
      cancel: () => undefined,
      shutdown: async () => undefined,
      terminate: async () => 0,
    };
  }
}

class ManualWatchdogTimer implements WatchdogTimerPort {
  callback: (() => void) | undefined;
  set(callback: () => void): unknown {
    this.callback = callback;
    return 1;
  }
  clear(): void {}
  fire(): void {
    this.callback?.();
  }
}

const setup = async (
  runner: WorkerRunner,
  readApiKey = async () => 'synthetic-credential',
  linearization?: {
    gate: LinearizationGate;
    readConfiguredApiKey: () => Promise<string | undefined>;
  },
  userConfig?: ProjectUserConfigPort,
) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'nw-task-host-'));
  roots.push(parent);
  const target = path.join(parent, 'project');
  const runtime = {
    appVersion: '0.1.0',
    electronVersion: '43.3.0',
    chromiumVersion: '150.0.0',
  };
  const projects = new ProjectService(
    {
      chooseNewProject: async () => target,
      chooseExistingProject: async () => undefined,
      chooseMinutesFile: async () => undefined,
    },
    runtime,
    linearization === undefined
      ? undefined
      : { readConfiguredApiKey: linearization.readConfiguredApiKey },
    linearization?.gate,
    userConfig,
  );
  const created = await projects.createWithDialog(
    { name: '任务项目', profile: 'official', initialMinutes: '2026年8月9日举行合成活动。' },
    20,
  );
  if (created.cancelled) throw new Error('unexpected cancellation');
  const tasks = new TaskHostService(
    projects,
    { readApiKey },
    runtime,
    runner,
    () => undefined,
    linearization?.gate,
  );
  return { projects, tasks, view: created.data, target, runtime };
};

const draftInput = (sessionId: Parameters<ProjectService['getOwned']>[0]) => ({
  sessionId,
  expectedRevision: 0,
  kind: 'draftGeneration' as const,
  parentVersionId: null,
  messages: [{ role: 'user' as const, content: '只输出干净新闻稿。根据纪要撰写新闻稿。' }] as [
    { role: 'user'; content: string },
  ],
  editedByUser: true,
  editWarningAcknowledged: true,
  promptInputFingerprint: sha256Schema.parse('0'.repeat(64)),
  staleResolution: 'continued' as const,
  acknowledgedRiskCodes: ['MISSING_FACTS'] as 'MISSING_FACTS'[],
});

const terminalBarrier = (tasks: TaskHostService) => {
  let resolveTerminal!: (status: string) => void;
  const terminal = new Promise<string>((resolve) => {
    resolveTerminal = resolve;
  });
  tasks.setListener(20, (event) => {
    if (['succeeded', 'failed', 'cancelled', 'timedOut'].includes(event.status)) {
      resolveTerminal(event.status);
    }
  });
  return terminal;
};

describe('TaskHostService', () => {
  it('recomputes a current Prompt and transports the exact prepared messages', async () => {
    const runner = new ImmediateRunner({
      id: 'prepared-response',
      model: 'deepseek-v4-pro',
      content: '合成活动顺利举行\n活动信息经核验后形成新闻稿。',
      finishReason: 'stop',
    });
    const { projects, tasks, view } = await setup(runner);
    const prepareInput = {
      sessionId: view.sessionId,
      expectedRevision: view.revision,
      kind: 'draftGeneration' as const,
      parentVersionId: null,
    };
    const prepared = await projects.preparePrompt(prepareInput, 20);
    expect(projects.getOwned(view.sessionId, 20).aggregate.revision).toBe(view.revision);
    const terminal = terminalBarrier(tasks);
    const queued = await tasks.start(
      {
        ...prepareInput,
        messages: [{ ...prepared.messages[0] }],
        editedByUser: false,
        editWarningAcknowledged: false,
        promptInputFingerprint: prepared.inputFingerprint,
        staleResolution: 'current',
        acknowledgedRiskCodes: prepared.risks.map((risk) => risk.code),
      },
      20,
    );
    const projected = projects
      .view(view.sessionId, 20)
      .tasks.find((candidate) => candidate.id === queued.id);
    expect(projected).toMatchObject({
      promptId: queued.promptId,
      configSnapshot: queued.configSnapshot,
      minutes: queued.minutes,
      retrieval: queued.retrieval,
      comments: queued.comments,
    });
    await expect(terminal).resolves.toBe('succeeded');
    expect(runner.lastInput?.messages).toEqual(prepared.messages);
    const aggregate = projects.getOwned(view.sessionId, 20).aggregate;
    const prompt = aggregate.prompts.find((candidate) => candidate.id === queued.promptId);
    const task = aggregate.tasks.find((candidate) => candidate.id === queued.id);
    expect(prompt?.upstream).toEqual({
      promptInputFingerprint: prepared.inputFingerprint,
      currentInputFingerprint: prepared.inputFingerprint,
      staleResolution: 'current',
    });
    expect(task).toMatchObject({
      promptId: prompt?.id,
      baseProjectRevision: view.revision,
      configSnapshot: prepared.resolvedConfig,
      minutesSnapshot: aggregate.minutes,
      retrievalUnavailable: true,
      commentSnapshot: [],
    });
    expect(task?.createdAt).toBe(prompt?.createdAt);
    expect(task).not.toHaveProperty('supplementalFacts');
    expect(task).not.toHaveProperty('retrievalReportId');
    expect(
      prompt?.messages.map((message) =>
        projects.getOwned(view.sessionId, 20).project.readText(message.contentRef),
      ),
    ).toEqual(prepared.messages.map((message) => message.content));
    await tasks.shutdownAll();
    await projects.closeAll();
  });

  it('transports manual fact overrides into the worker and successful version snapshot', async () => {
    const runner = new ImmediateRunner({
      id: 'fact-override-response',
      model: 'deepseek-v4-pro',
      content: '合成活动顺利举行\n活动信息经核验后形成新闻稿。',
      finishReason: 'stop',
    });
    const { projects, tasks, view } = await setup(runner);
    const factOverrides = {
      date: { mode: 'manual' as const, value: '2026年8月' },
      location: { mode: 'manual' as const, value: '线上会议室' },
      organizer: { mode: 'none' as const },
    };
    const prepareInput = {
      sessionId: view.sessionId,
      expectedRevision: view.revision,
      kind: 'draftGeneration' as const,
      parentVersionId: null,
      factOverrides,
    };
    const prepared = await projects.preparePrompt(prepareInput, 20);
    expect(prepared.messages[0]?.content).toContain('2026年8月');
    expect(prepared.messages[0]?.content).toContain('线上会议室');
    expect(prepared.messages[0]?.content).toContain('用户确认未提供');
    const terminal = terminalBarrier(tasks);
    const queued = await tasks.start(
      {
        ...prepareInput,
        messages: [{ ...prepared.messages[0] }],
        editedByUser: false,
        editWarningAcknowledged: false,
        promptInputFingerprint: prepared.inputFingerprint,
        staleResolution: 'current',
        acknowledgedRiskCodes: prepared.risks.map((risk) => risk.code),
      },
      20,
    );
    await expect(terminal).resolves.toBe('succeeded');
    expect(runner.lastInput?.messages[0]?.content).toContain('2026年8月');
    expect(runner.lastInput?.messages[0]?.content).toContain('线上会议室');
    const aggregate = projects.getOwned(view.sessionId, 20).aggregate;
    expect(aggregate.tasks.find((task) => task.id === queued.id)?.factOverrides).toEqual(
      factOverrides,
    );
    expect(aggregate.versions[0]?.factOverrides).toEqual(factOverrides);
    await tasks.shutdownAll();
    await projects.closeAll();
  });

  it.each(['continued', 'regenerated'] as const)(
    'accepts a valid %s stale decision and snapshots the authoritative fingerprints',
    async (decision) => {
      const runner = new ImmediateRunner({
        id: `accepted-${decision}`,
        model: 'deepseek-v4-pro',
        content: '合成活动形成一篇完整新闻稿。',
        finishReason: 'stop',
      });
      const { projects, tasks, view } = await setup(runner);
      const base = {
        sessionId: view.sessionId,
        expectedRevision: view.revision,
        kind: 'draftGeneration' as const,
        parentVersionId: null,
      };
      const previous = await projects.preparePrompt(base, 20);
      const changed = await projects.saveMinutes(
        {
          sessionId: view.sessionId,
          expectedRevision: view.revision,
          content: '活动日期：2099年1月1日\n活动地点：A101\n举办单位：测试单位\n',
        },
        20,
      );
      const current = await projects.preparePrompt(
        { ...base, expectedRevision: changed.revision },
        20,
      );
      const selected = decision === 'continued' ? previous : current;
      const terminal = terminalBarrier(tasks);
      const queued = await tasks.start(
        {
          ...base,
          expectedRevision: changed.revision,
          messages: [{ ...selected.messages[0] }],
          editedByUser: decision === 'continued',
          editWarningAcknowledged: decision === 'continued',
          promptInputFingerprint: selected.inputFingerprint,
          staleResolution: decision,
          ...(decision === 'regenerated'
            ? { previousPromptInputFingerprint: previous.inputFingerprint }
            : {}),
          acknowledgedRiskCodes: selected.risks.map((risk) => risk.code),
        },
        20,
      );
      await expect(terminal).resolves.toBe('succeeded');
      const task = projects
        .getOwned(view.sessionId, 20)
        .aggregate.tasks.find((candidate) => candidate.id === queued.id);
      const prompt = projects
        .getOwned(view.sessionId, 20)
        .aggregate.prompts.find((candidate) => candidate.id === queued.promptId);
      expect(prompt?.upstream).toMatchObject({
        promptInputFingerprint: selected.inputFingerprint,
        currentInputFingerprint: current.inputFingerprint,
        staleResolution: decision,
      });
      expect(task?.minutesSnapshot.revisionId).toBe(changed.minutes.revisionId);
      await tasks.shutdownAll();
      await projects.closeAll();
    },
  );

  it.each([
    ['current with changed input', 'current', 'previous', false],
    ['continued with current input', 'continued', 'current', false],
    ['regenerated with equal previous hash', 'regenerated', 'current', true],
    ['regenerated without previous hash', 'regenerated', 'current', false],
  ] as const)(
    'rejects %s without persisting or starting a worker',
    async (_name, decision, selectedName, includePrevious) => {
      const runner = new PendingRunner();
      const { projects, tasks, view } = await setup(runner);
      const base = {
        sessionId: view.sessionId,
        expectedRevision: view.revision,
        kind: 'draftGeneration' as const,
        parentVersionId: null,
      };
      const previous = await projects.preparePrompt(base, 20);
      const changed = await projects.saveMinutes(
        {
          sessionId: view.sessionId,
          expectedRevision: view.revision,
          content: '活动日期：2099年1月2日\n活动地点：B202\n举办单位：测试单位\n',
        },
        20,
      );
      const current = await projects.preparePrompt(
        { ...base, expectedRevision: changed.revision },
        20,
      );
      const selected = selectedName === 'previous' ? previous : current;
      await expect(
        tasks.start(
          {
            ...base,
            expectedRevision: changed.revision,
            messages: [{ ...selected.messages[0] }],
            editedByUser: true,
            editWarningAcknowledged: true,
            promptInputFingerprint: selected.inputFingerprint,
            staleResolution: decision,
            ...(includePrevious
              ? { previousPromptInputFingerprint: current.inputFingerprint }
              : {}),
            acknowledgedRiskCodes: selected.risks.map((risk) => risk.code),
          } as never,
          20,
        ),
      ).rejects.toMatchObject({ safe: { code: 'PROJECT_CONFLICT' } });
      const aggregate = projects.getOwned(view.sessionId, 20).aggregate;
      expect(aggregate.prompts).toHaveLength(0);
      expect(aggregate.tasks).toHaveLength(0);
      expect(runner.starts).toBe(0);
      await tasks.shutdownAll();
      await projects.closeAll();
    },
  );

  it('keeps all four config layers and sources identical across prepare, task, and worker', async () => {
    const runner = new ImmediateRunner({
      id: 'config-response',
      model: 'deepseek-v4-pro',
      content: '配置追溯测试生成了完整新闻稿。',
      finishReason: 'stop',
    });
    const userConfig: ProjectUserConfigPort = {
      get: () => Promise.resolve({ revision: 3, config: { targetChannel: '用户渠道' } }),
      update: () => Promise.reject(new Error('not used')),
    };
    const { projects, tasks, view } = await setup(runner, undefined, undefined, userConfig);
    const configured = await projects.updateConfig(
      {
        sessionId: view.sessionId,
        expectedRevision: view.revision,
        config: { maxWords: 760 },
      },
      20,
    );
    const taskConfig = { reasoningEffort: 'high' as const };
    const prepareInput = {
      sessionId: view.sessionId,
      expectedRevision: configured.revision,
      kind: 'draftGeneration' as const,
      parentVersionId: null,
      taskConfig,
    };
    const prepared = await projects.preparePrompt(prepareInput, 20);
    expect(prepared.resolvedConfig).toMatchObject({
      values: {
        model: DEFAULT_GENERATION_CONFIG.model,
        targetChannel: '用户渠道',
        maxWords: 760,
        reasoningEffort: 'high',
        requestTimeoutMs: DEFAULT_GENERATION_CONFIG.requestTimeoutMs,
      },
      sources: {
        model: 'default',
        targetChannel: 'user',
        maxWords: 'project',
        reasoningEffort: 'task',
        requestTimeoutMs: 'default',
      },
    });
    const terminal = terminalBarrier(tasks);
    const queued = await tasks.start(
      {
        ...prepareInput,
        messages: [{ ...prepared.messages[0] }],
        editedByUser: false,
        editWarningAcknowledged: false,
        promptInputFingerprint: prepared.inputFingerprint,
        staleResolution: 'current',
        acknowledgedRiskCodes: prepared.risks.map((risk) => risk.code),
      },
      20,
    );
    await expect(terminal).resolves.toBe('succeeded');
    const task = projects
      .getOwned(view.sessionId, 20)
      .aggregate.tasks.find((candidate) => candidate.id === queued.id);
    expect(task?.configSnapshot).toEqual(prepared.resolvedConfig);
    expect(runner.lastInput).toMatchObject({
      model: prepared.resolvedConfig.values.model,
      reasoningEffort: prepared.resolvedConfig.values.reasoningEffort,
      maxWords: prepared.resolvedConfig.values.maxWords,
    });
    await tasks.shutdownAll();
    await projects.closeAll();
  });

  it('rejects current after an authoritative project-config change', async () => {
    const runner = new PendingRunner();
    const { projects, tasks, view } = await setup(runner);
    const base = {
      sessionId: view.sessionId,
      expectedRevision: view.revision,
      kind: 'draftGeneration' as const,
      parentVersionId: null,
    };
    const prepared = await projects.preparePrompt(base, 20);
    const changed = await projects.updateConfig(
      { sessionId: view.sessionId, expectedRevision: view.revision, config: { maxWords: 740 } },
      20,
    );
    await expect(
      tasks.start(
        {
          ...base,
          expectedRevision: changed.revision,
          messages: [{ ...prepared.messages[0] }],
          editedByUser: false,
          editWarningAcknowledged: false,
          promptInputFingerprint: prepared.inputFingerprint,
          staleResolution: 'current',
          acknowledgedRiskCodes: prepared.risks.map((risk) => risk.code),
        },
        20,
      ),
    ).rejects.toMatchObject({ safe: { code: 'PROJECT_CONFLICT' } });
    expect(projects.getOwned(view.sessionId, 20).aggregate.tasks).toHaveLength(0);
    expect(runner.starts).toBe(0);
    await projects.closeAll();
  });

  it('rejects current after the authoritative retrieval reference changes', async () => {
    const runner = new PendingRunner();
    const { projects, tasks, view, runtime } = await setup(runner);
    const makeReport = (label: string) => ({
      id: retrievalReportIdSchema.parse(randomUUID()),
      createdAt: systemClock.now(),
      knowledgeVersion: `knowledge-${label}`,
      retrievalEngineVersion: 'bm25-v1',
      redactedQueryText: `query-${label}`,
      querySha256: sha256Schema.parse(
        createHash('sha256').update(`query-${label}`, 'utf8').digest('hex'),
      ),
      factHints: {
        dates: [],
        times: [],
        locations: [],
        participants: [],
        missing: [],
      },
      hits: [],
    });
    const commitReport = async (report: ReturnType<typeof makeReport>) => {
      const owned = projects.getOwned(view.sessionId, 20);
      const next = recordRetrieval(
        owned.aggregate,
        report,
        owned.aggregate.revision,
        systemClock.now(),
        runtime,
      );
      await owned.project.commit({
        transactionId: makeTransactionId(),
        commitId: makeCommitId(),
        expectedRevision: owned.aggregate.revision,
        expectedHeadCommitId: owned.project.headCommitId,
        nextAggregate: next,
      });
      return next;
    };

    const reportA = makeReport('a');
    const withA = await commitReport(reportA);
    const prepared = await projects.preparePrompt(
      {
        sessionId: view.sessionId,
        expectedRevision: withA.revision,
        kind: 'draftGeneration',
        parentVersionId: null,
        retrievalReportId: reportA.id,
      },
      20,
    );
    const reportB = makeReport('b');
    const withB = await commitReport(reportB);

    await expect(
      tasks.start(
        {
          sessionId: view.sessionId,
          expectedRevision: withB.revision,
          kind: 'draftGeneration',
          parentVersionId: null,
          retrievalReportId: reportB.id,
          messages: [{ ...prepared.messages[0] }],
          editedByUser: false,
          editWarningAcknowledged: false,
          promptInputFingerprint: prepared.inputFingerprint,
          staleResolution: 'current',
          acknowledgedRiskCodes: prepared.risks.map((risk) => risk.code),
        },
        20,
      ),
    ).rejects.toMatchObject({ safe: { code: 'PROJECT_CONFLICT' } });
    const aggregate = projects.getOwned(view.sessionId, 20).aggregate;
    expect(aggregate.prompts).toHaveLength(0);
    expect(aggregate.tasks).toHaveLength(0);
    expect(runner.starts).toBe(0);
    await projects.closeAll();
  });

  it('rejects current after the parent comment snapshot changes', async () => {
    const content = '批注变化测试标题\n\n第一段需要修改，第二处也需要修改。';
    const runner = new ImmediateRunner({
      id: 'comment-change',
      model: 'deepseek-v4-pro',
      content,
      finishReason: 'stop',
    });
    const { projects, tasks, view } = await setup(runner);
    const draftPrepare = await projects.preparePrompt(
      {
        sessionId: view.sessionId,
        expectedRevision: view.revision,
        kind: 'draftGeneration',
        parentVersionId: null,
      },
      20,
    );
    const terminal = terminalBarrier(tasks);
    await tasks.start(
      {
        sessionId: view.sessionId,
        expectedRevision: view.revision,
        kind: 'draftGeneration',
        parentVersionId: null,
        messages: [{ ...draftPrepare.messages[0] }],
        editedByUser: false,
        editWarningAcknowledged: false,
        promptInputFingerprint: draftPrepare.inputFingerprint,
        staleResolution: 'current',
        acknowledgedRiskCodes: draftPrepare.risks.map((risk) => risk.code),
      },
      20,
    );
    await expect(terminal).resolves.toBe('succeeded');
    let aggregate = projects.getOwned(view.sessionId, 20).aggregate;
    const version = aggregate.versions.at(-1)!;
    const add = async (quote: string, body: string) => {
      aggregate = projects.getOwned(view.sessionId, 20).aggregate;
      const start = content.indexOf(quote);
      await projects.addComment(
        {
          sessionId: view.sessionId,
          expectedRevision: aggregate.revision,
          versionId: version.id,
          anchor: {
            kind: 'textQuote',
            contentSha256: version.contentRef.sha256,
            start,
            end: start + quote.length,
            exact: quote,
            prefix: '',
            suffix: '',
          },
          quotedText: quote,
          body,
        },
        20,
      );
    };
    await add('第一段', '先改第一段');
    aggregate = projects.getOwned(view.sessionId, 20).aggregate;
    const revisionPrepare = await projects.preparePrompt(
      {
        sessionId: view.sessionId,
        expectedRevision: aggregate.revision,
        kind: 'commentRevision',
        parentVersionId: version.id,
      },
      20,
    );
    await add('第二处', '再改第二处');
    aggregate = projects.getOwned(view.sessionId, 20).aggregate;
    await expect(
      tasks.start(
        {
          sessionId: view.sessionId,
          expectedRevision: aggregate.revision,
          kind: 'commentRevision',
          parentVersionId: version.id,
          messages: [{ ...revisionPrepare.messages[0] }],
          editedByUser: false,
          editWarningAcknowledged: false,
          promptInputFingerprint: revisionPrepare.inputFingerprint,
          staleResolution: 'current',
          acknowledgedRiskCodes: revisionPrepare.risks.map((risk) => risk.code),
        },
        20,
      ),
    ).rejects.toMatchObject({ safe: { code: 'PROJECT_CONFLICT' } });
    expect(runner.starts).toBe(1);
    await projects.closeAll();
  });

  it('inherits fact overrides only from the selected parent branch', async () => {
    const runner = new ImmediateRunner({
      id: 'branch-response',
      model: 'deepseek-v4-pro',
      content: '分支测试生成了结构完整的新闻稿。',
      finishReason: 'stop',
    });
    const { projects, tasks, view } = await setup(runner);
    const runCurrent = async (
      kind: 'draftGeneration' | 'aiReview',
      parentVersionId: ReturnType<typeof versionIdSchema.parse> | null,
      factOverrides?: {
        location?: { mode: 'auto' } | { mode: 'manual'; value: string } | { mode: 'none' };
      },
    ) => {
      const revision = projects.getOwned(view.sessionId, 20).aggregate.revision;
      const prepareInput = {
        sessionId: view.sessionId,
        expectedRevision: revision,
        kind,
        parentVersionId,
        ...(factOverrides === undefined ? {} : { factOverrides }),
      };
      const prepared = await projects.preparePrompt(prepareInput, 20);
      const terminal = terminalBarrier(tasks);
      await tasks.start(
        {
          ...prepareInput,
          messages: [{ ...prepared.messages[0] }],
          editedByUser: false,
          editWarningAcknowledged: false,
          promptInputFingerprint: prepared.inputFingerprint,
          staleResolution: 'current',
          acknowledgedRiskCodes: prepared.risks.map((risk) => risk.code),
        },
        20,
      );
      await expect(terminal).resolves.toBe('succeeded');
      return projects.getOwned(view.sessionId, 20).aggregate.latestVersionId!;
    };
    const rootVersion = await runCurrent('draftGeneration', null);
    const branchA = await runCurrent('aiReview', rootVersion, {
      location: { mode: 'manual', value: 'A分支会场' },
    });
    let aggregate = projects.getOwned(view.sessionId, 20).aggregate;
    await projects.setLatestVersion(
      {
        sessionId: view.sessionId,
        expectedRevision: aggregate.revision,
        versionId: rootVersion,
      },
      20,
    );
    const branchB = await runCurrent('aiReview', rootVersion, {
      location: { mode: 'manual', value: 'B分支会场' },
    });
    aggregate = projects.getOwned(view.sessionId, 20).aggregate;
    await projects.setLatestVersion(
      {
        sessionId: view.sessionId,
        expectedRevision: aggregate.revision,
        versionId: branchA,
      },
      20,
    );
    aggregate = projects.getOwned(view.sessionId, 20).aggregate;
    const preparedFromA = await projects.preparePrompt(
      {
        sessionId: view.sessionId,
        expectedRevision: aggregate.revision,
        kind: 'aiReview',
        parentVersionId: branchA,
      },
      20,
    );
    expect(preparedFromA.messages[0].content).toContain('A分支会场');
    expect(preparedFromA.messages[0].content).not.toContain('B分支会场');
    const clearedFromA = await projects.preparePrompt(
      {
        sessionId: view.sessionId,
        expectedRevision: aggregate.revision,
        kind: 'aiReview',
        parentVersionId: branchA,
        factOverrides: { location: { mode: 'auto' } },
      },
      20,
    );
    expect(clearedFromA.factOverrides?.location).toEqual({ mode: 'auto' });
    expect(clearedFromA.messages[0].content).not.toContain('A分支会场');
    expect(branchB).not.toBe(branchA);
    await projects.setLatestVersion(
      {
        sessionId: view.sessionId,
        expectedRevision: aggregate.revision,
        versionId: branchB,
      },
      20,
    );
    const afterSwitch = projects.getOwned(view.sessionId, 20).aggregate;
    await expect(
      tasks.start(
        {
          sessionId: view.sessionId,
          expectedRevision: afterSwitch.revision,
          kind: 'aiReview',
          parentVersionId: branchA,
          messages: [{ ...preparedFromA.messages[0] }],
          editedByUser: false,
          editWarningAcknowledged: false,
          promptInputFingerprint: preparedFromA.inputFingerprint,
          staleResolution: 'current',
          acknowledgedRiskCodes: preparedFromA.risks.map((risk) => risk.code),
        },
        20,
      ),
    ).rejects.toMatchObject({ safe: { code: 'PROJECT_STATE_CONFLICT' } });
    await tasks.shutdownAll();
    await projects.closeAll();
  }, 20_000);

  it('returns after queueing and completes through the existing version transaction', async () => {
    const runner = new ImmediateRunner({
      id: 'synthetic-response',
      model: 'deepseek-v4-pro',
      content: '合成活动顺利举行\n参与人员围绕活动主题开展了深入交流。',
      finishReason: 'stop',
    });
    const { projects, tasks, view } = await setup(runner);
    const terminal = terminalBarrier(tasks);
    const queued = await tasks.start(draftInput(view.sessionId), 20);
    expect(['queued', 'preparing']).toContain(queued.status);
    await expect(terminal).resolves.toBe('succeeded');
    const aggregate = projects.getOwned(view.sessionId, 20).aggregate;
    expect(aggregate.versions).toHaveLength(1);
    expect(aggregate.latestVersionId).toBe(aggregate.versions[0]?.id);
    expect(runner.starts).toBe(1);
    await tasks.shutdownAll();
    await projects.closeAll();
  });

  it('persists cancellation without creating a version', async () => {
    const runner = new PendingRunner();
    const { projects, tasks, view } = await setup(runner);
    const queued = await tasks.start(draftInput(view.sessionId), 20);
    await runner.started;
    // Replacing the owner listener models a reloaded renderer subscribing to the main-owned task.
    const terminal = terminalBarrier(tasks);
    const revision = projects.getOwned(view.sessionId, 20).aggregate.revision;
    await expect(
      projects.close({ sessionId: view.sessionId, expectedRevision: revision }, 20),
    ).rejects.toMatchObject({ safe: { code: 'PROJECT_STATE_CONFLICT' } });
    await expect(
      tasks.cancel(
        { sessionId: view.sessionId, expectedRevision: revision, taskId: queued.id },
        20,
      ),
    ).resolves.toEqual({ disposition: 'accepted' });
    await expect(terminal).resolves.toBe('cancelled');
    expect(projects.getOwned(view.sessionId, 20).aggregate.versions).toHaveLength(0);
    await tasks.shutdownAll();
    await projects.closeAll();
  });

  it('shutdown waits for cancellation persistence before project locks may close', async () => {
    const runner = new PendingRunner();
    const { projects, tasks, view } = await setup(runner);
    await tasks.start(draftInput(view.sessionId), 20);
    await runner.started;
    await tasks.shutdownAll();
    expect(projects.getOwned(view.sessionId, 20).aggregate.tasks[0]?.status).toBe('cancelled');
    await projects.closeAll();
  });

  it('shutdown observes saving and waits for the success transaction', async () => {
    const runner = new DeferredSuccessRunner();
    const { projects, tasks, view } = await setup(runner);
    let resolveSaving!: () => void;
    const saving = new Promise<void>((resolve) => {
      resolveSaving = resolve;
    });
    tasks.setListener(20, (event) => {
      if (event.status === 'saving') resolveSaving();
    });
    await tasks.start(draftInput(view.sessionId), 20);
    await runner.started;
    runner.complete();
    await saving;
    await tasks.shutdownAll();
    const aggregate = projects.getOwned(view.sessionId, 20).aggregate;
    expect(aggregate.tasks[0]?.status).toBe('succeeded');
    expect(aggregate.versions).toHaveLength(1);
    await projects.closeAll();
  });

  it('watchdog timeout does not fabricate a terminal state while a transition is blocked', async () => {
    const runner = new PendingRunner();
    const { projects, tasks, view } = await setup(runner);
    let queueCommitted = false;
    let releaseTransition!: () => void;
    const transitionGate = new Promise<void>((resolve) => {
      releaseTransition = resolve;
    });
    let resolveBlocked!: () => void;
    const transitionBlocked = new Promise<void>((resolve) => {
      resolveBlocked = resolve;
    });
    setCommitBarrierForTest(async (barrier) => {
      if (barrier === 'afterHeadReplace') queueCommitted = true;
      if (queueCommitted && barrier === 'afterPrepare') {
        resolveBlocked();
        await transitionGate;
      }
    });
    await tasks.start(draftInput(view.sessionId), 20);
    await transitionBlocked;
    const shutdown = tasks.shutdownAll();
    const timer = new ManualWatchdogTimer();
    const watched = runWithWatchdog(shutdown, 10_000, () => undefined, timer);
    timer.fire();
    await expect(watched).resolves.toBe('timedOut');
    expect(projects.getOwned(view.sessionId, 20).aggregate.tasks[0]?.status).toBe('queued');
    releaseTransition();
    await shutdown;
    expect(projects.getOwned(view.sessionId, 20).aggregate.tasks[0]?.status).toBe('cancelled');
    await projects.closeAll();
  });

  it('watchdog timeout leaves a blocked saving commit recoverable without fake success', async () => {
    const runner = new DeferredSuccessRunner();
    const { projects, tasks, view } = await setup(runner);
    let savingReached = false;
    let releaseCompletion!: () => void;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    let resolveBlocked!: () => void;
    const completionBlocked = new Promise<void>((resolve) => {
      resolveBlocked = resolve;
    });
    tasks.setListener(20, (event) => {
      if (event.status === 'saving') savingReached = true;
    });
    let injected = false;
    setCommitBarrierForTest(async (barrier) => {
      if (savingReached && !injected && barrier === 'afterHeadReplace') {
        injected = true;
        resolveBlocked();
        await completionGate;
        throw new Error('synthetic post-head completion response loss');
      }
    });
    await tasks.start(draftInput(view.sessionId), 20);
    await runner.started;
    runner.complete();
    await completionBlocked;
    const shutdown = tasks.shutdownAll();
    const timer = new ManualWatchdogTimer();
    const watched = runWithWatchdog(shutdown, 10_000, () => undefined, timer);
    timer.fire();
    await expect(watched).resolves.toBe('timedOut');
    const duringTimeout = projects.getOwned(view.sessionId, 20).aggregate;
    expect(duringTimeout.tasks[0]?.status).toBe('saving');
    expect(duringTimeout.versions).toHaveLength(0);
    releaseCompletion();
    await shutdown;
    const completed = projects.getOwned(view.sessionId, 20).aggregate;
    expect(completed.tasks[0]?.status).toBe('succeeded');
    expect(completed.versions).toHaveLength(1);
    await projects.closeAll();
  });

  it('rejects latest switching while a task is processing', async () => {
    const runner = new PendingRunner();
    const { projects, tasks, view } = await setup(runner);
    const queued = await tasks.start(draftInput(view.sessionId), 20);
    await runner.started;
    const current = projects.getOwned(view.sessionId, 20).aggregate;
    expect(['preparing', 'requesting', 'processing']).toContain(
      current.tasks.find((task) => task.id === queued.id)?.status,
    );
    await expect(
      projects.setLatestVersion(
        {
          sessionId: view.sessionId,
          expectedRevision: current.revision,
          versionId: versionIdSchema.parse(randomUUID()),
        },
        20,
      ),
    ).rejects.toMatchObject({ safe: { code: 'PROJECT_STATE_CONFLICT' } });
    expect(projects.getOwned(view.sessionId, 20).aggregate.latestVersionId).toBeNull();
    await tasks.cancel(
      { sessionId: view.sessionId, expectedRevision: current.revision, taskId: queued.id },
      20,
    );
    await tasks.shutdownAll();
    await projects.closeAll();
  });

  it('reconciles a completion failure before the commit point to failed without a version', async () => {
    const runner = new DeferredSuccessRunner();
    const { projects, tasks, view } = await setup(runner);
    let savingReached = false;
    let injected = false;
    setCommitBarrierForTest((barrier) => {
      if (savingReached && !injected && barrier === 'afterPrepare') {
        injected = true;
        throw new Error('synthetic pre-commit failure');
      }
    });
    let resolveTerminal!: (status: string) => void;
    const reconciled = new Promise<string>((resolve) => {
      resolveTerminal = resolve;
    });
    tasks.setListener(20, (event) => {
      if (event.status === 'saving') savingReached = true;
      if (['succeeded', 'failed', 'cancelled', 'timedOut'].includes(event.status)) {
        resolveTerminal(event.status);
      }
    });
    await tasks.start(draftInput(view.sessionId), 20);
    await runner.started;
    runner.complete();
    await expect(reconciled).resolves.toBe('failed');
    const aggregate = projects.getOwned(view.sessionId, 20).aggregate;
    expect(injected).toBe(true);
    expect(injected).toBe(true);
    expect(aggregate.tasks[0]).toMatchObject({
      status: 'failed',
      error: { code: 'TASK_INTERRUPTED' },
    });
    expect(aggregate.versions).toHaveLength(0);
    expect(aggregate.latestVersionId).toBeNull();
    await tasks.shutdownAll();
    await projects.closeAll();
  });

  it('refreshes after a post-head completion error without duplicating the successful version', async () => {
    const runner = new DeferredSuccessRunner();
    const { projects, tasks, view, target, runtime } = await setup(runner);
    let savingReached = false;
    let injected = false;
    const terminal = new Promise<string>((resolve) => {
      tasks.setListener(20, (event) => {
        if (event.status === 'saving') savingReached = true;
        if (['succeeded', 'failed', 'cancelled', 'timedOut'].includes(event.status)) {
          resolve(event.status);
        }
      });
    });
    setCommitBarrierForTest((barrier) => {
      if (savingReached && !injected && barrier === 'afterHeadReplace') {
        injected = true;
        throw new Error('synthetic post-head failure');
      }
    });
    await tasks.start(draftInput(view.sessionId), 20);
    await runner.started;
    runner.complete();
    await expect(terminal).resolves.toBe('succeeded');
    const aggregate = projects.getOwned(view.sessionId, 20).aggregate;
    expect(injected).toBe(true);
    expect(aggregate.tasks[0]?.status).toBe('succeeded');
    expect(aggregate.versions).toHaveLength(1);
    expect(aggregate.latestVersionId).toBe(aggregate.versions[0]?.id);
    await tasks.shutdownAll();
    expect(projects.getOwned(view.sessionId, 20).aggregate.versions).toHaveLength(1);
    const revision = aggregate.revision;
    await projects.getOwned(view.sessionId, 20).project.close();
    const reopenedProjects = new ProjectService(
      {
        chooseNewProject: async () => undefined,
        chooseExistingProject: async () => target,
        chooseMinutesFile: async () => undefined,
      },
      runtime,
    );
    const reopened = await reopenedProjects.openWithDialog(20);
    if (reopened.cancelled || 'recoveryRequired' in reopened)
      throw new Error('unexpected cancellation');
    expect(reopened.data.revision).toBe(revision);
    expect(reopened.data.tasks[0]?.status).toBe('succeeded');
    expect(reopened.data.versions).toHaveLength(1);
    await reopenedProjects.close(
      {
        sessionId: reopened.data.sessionId,
        expectedRevision: reopened.data.revision,
      },
      20,
    );
  });

  it('keeps the prior version intact when latest switching races a saving commit', async () => {
    const firstRunner = new ImmediateRunner({
      id: 'first-response',
      model: 'deepseek-v4-pro',
      content: 'First synthetic news title\nFirst synthetic news body with sufficient detail.',
      finishReason: 'stop',
    });
    const secondRunner = new DeferredSuccessRunner();
    const { projects, tasks, view } = await setup(new SequenceRunner([firstRunner, secondRunner]));
    const firstTerminal = terminalBarrier(tasks);
    await tasks.start(draftInput(view.sessionId), 20);
    await expect(firstTerminal).resolves.toBe('succeeded');
    const firstAggregate = projects.getOwned(view.sessionId, 20).aggregate;
    const firstVersion = firstAggregate.versions[0]!;

    let savingReached = false;
    let releaseCompletion!: () => void;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    let resolveBlocked!: () => void;
    const completionBlocked = new Promise<void>((resolve) => {
      resolveBlocked = resolve;
    });
    setCommitBarrierForTest(async (barrier) => {
      if (savingReached && barrier === 'afterPrepare') {
        resolveBlocked();
        await completionGate;
      }
    });
    tasks.setListener(20, (event) => {
      if (event.status === 'saving') savingReached = true;
    });
    const reviewInput = {
      ...draftInput(view.sessionId),
      expectedRevision: firstAggregate.revision,
      kind: 'aiReview' as const,
      parentVersionId: firstVersion.id,
    };
    await tasks.start(reviewInput, 20);
    await secondRunner.started;
    secondRunner.complete();
    await completionBlocked;
    const saving = projects.getOwned(view.sessionId, 20).aggregate;
    const latestAttempt = projects.setLatestVersion(
      {
        sessionId: view.sessionId,
        expectedRevision: saving.revision,
        versionId: firstVersion.id,
      },
      20,
    );
    await expect(latestAttempt).rejects.toMatchObject({
      safe: { code: 'PROJECT_STATE_CONFLICT' },
    });
    releaseCompletion();
    await tasks.shutdownAll();
    const completed = projects.getOwned(view.sessionId, 20).aggregate;
    expect(completed.versions).toHaveLength(2);
    expect(completed.latestVersionId).toBe(completed.versions[1]?.id);
    expect(completed.versions[0]?.contentRef.sha256).toBe(firstVersion.contentRef.sha256);
    await projects.closeAll();
  });

  it('persists worker failures without changing versions', async () => {
    const { projects, tasks, view } = await setup(new FailingRunner());
    const terminal = terminalBarrier(tasks);
    await tasks.start(draftInput(view.sessionId), 20);
    await expect(terminal).resolves.toBe('failed');
    const aggregate = projects.getOwned(view.sessionId, 20).aggregate;
    expect(aggregate.tasks[0]).toMatchObject({
      status: 'failed',
      error: { code: 'SERVICE_UNAVAILABLE' },
    });
    expect(aggregate.versions).toHaveLength(0);
    await tasks.shutdownAll();
    await projects.closeAll();
  });

  it.each([
    ['401', 'AUTH_REJECTED', 401],
    ['402', 'INSUFFICIENT_BALANCE', 402],
    ['429', 'RATE_LIMITED', 429],
    ['500', 'SERVICE_UNAVAILABLE', 500],
    ['503', 'SERVICE_UNAVAILABLE', 503],
    ['network', 'NETWORK_UNAVAILABLE', undefined],
    ['protocol', 'PROTOCOL_INVALID', undefined],
    ['worker crash', 'TASK_INTERRUPTED', undefined],
  ] as const)(
    'persists %s host failure without creating a version',
    async (_scenario, code, httpStatus) => {
      const runner = new SafeFailingRunner(
        makeSafeError(code, 'Synthetic safe failure', {
          retryable: true,
          ...(httpStatus === undefined ? {} : { httpStatus }),
        }),
      );
      const { projects, tasks, view } = await setup(runner);
      const terminal = terminalBarrier(tasks);
      await tasks.start(draftInput(view.sessionId), 20);
      await expect(terminal).resolves.toBe('failed');
      const aggregate = projects.getOwned(view.sessionId, 20).aggregate;
      expect(aggregate.tasks[0]).toMatchObject({
        status: 'failed',
        error: { code, ...(httpStatus === undefined ? {} : { httpStatus }) },
      });
      expect(aggregate.versions).toHaveLength(0);
      expect(aggregate.latestVersionId).toBeNull();
      expect(runner.starts).toBe(1);
      await tasks.shutdownAll();
      await projects.closeAll();
    },
  );

  it('rejects an empty response at the host boundary without creating a version', async () => {
    const runner = new ImmediateRunner({
      id: 'empty-response',
      model: 'deepseek-v4-pro',
      content: '',
      finishReason: 'stop',
    });
    const { projects, tasks, view } = await setup(runner);
    const terminal = terminalBarrier(tasks);
    await tasks.start(draftInput(view.sessionId), 20);
    await expect(terminal).resolves.toBe('failed');
    const aggregate = projects.getOwned(view.sessionId, 20).aggregate;
    expect(aggregate.tasks[0]).toMatchObject({
      status: 'failed',
      error: { code: 'EMPTY_RESPONSE' },
    });
    expect(aggregate.versions).toHaveLength(0);
    expect(aggregate.latestVersionId).toBeNull();
    await tasks.shutdownAll();
    await projects.closeAll();
  });

  it('isolates task events by owner and never forwards a forged worker status', async () => {
    const { projects, tasks, view } = await setup(new ForgedStatusRunner());
    const ownerEvents: string[] = [];
    const otherOwnerEvents: string[] = [];
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    tasks.setListener(20, (event) => {
      ownerEvents.push(event.status);
      if (event.status === 'failed') resolveTerminal();
    });
    tasks.setListener(21, (event) => otherOwnerEvents.push(event.status));
    await tasks.start(draftInput(view.sessionId), 20);
    await terminal;
    expect(ownerEvents).toContain('failed');
    expect(ownerEvents).not.toContain('forged');
    expect(otherOwnerEvents).toEqual([]);
    expect(projects.getOwned(view.sessionId, 20).aggregate.versions).toHaveLength(0);
    await tasks.shutdownAll();
    await projects.closeAll();
  });

  it('serializes concurrent starts so only one task and worker are created', async () => {
    const runner = new PendingRunner();
    const { projects, tasks, view } = await setup(runner);
    const results = await Promise.allSettled([
      tasks.start(draftInput(view.sessionId), 20),
      tasks.start(draftInput(view.sessionId), 20),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await runner.started;
    const aggregate = projects.getOwned(view.sessionId, 20).aggregate;
    expect(aggregate.prompts).toHaveLength(1);
    expect(aggregate.tasks).toHaveLength(1);
    expect(aggregate.versions).toHaveLength(0);
    expect(runner.starts).toBe(1);
    await tasks.cancel(
      {
        sessionId: view.sessionId,
        expectedRevision: aggregate.revision,
        taskId: aggregate.tasks[0]!.id,
      },
      20,
    );
    await tasks.shutdownAll();
    await projects.closeAll();
  });

  it.each(['succeeded', 'failed', 'cancelled', 'timedOut'] as const)(
    'allows an immediate retry from the %s terminal event',
    async (terminalStatus) => {
      const secondRunner = new PendingRunner();
      let firstPending: PendingRunner | undefined;
      let firstRunner: WorkerRunner;
      if (terminalStatus === 'succeeded') {
        firstRunner = new ImmediateRunner({
          id: 'terminal-success',
          model: 'deepseek-v4-pro',
          content: 'Synthetic terminal title\nSynthetic terminal body with sufficient detail.',
          finishReason: 'stop',
        });
      } else if (terminalStatus === 'failed') {
        firstRunner = new SafeFailingRunner(
          makeSafeError('SERVICE_UNAVAILABLE', 'Synthetic terminal failure'),
        );
      } else {
        firstPending = new PendingRunner();
        firstRunner = firstPending;
      }
      const { projects, tasks, view } = await setup(
        new SequenceRunner([firstRunner, secondRunner]),
      );
      let retryStarted = false;
      let retry: ReturnType<TaskHostService['start']> | undefined;
      let resolveTerminal!: () => void;
      const terminal = new Promise<void>((resolve) => {
        resolveTerminal = resolve;
      });
      tasks.setListener(20, (event) => {
        if (event.status !== terminalStatus || retryStarted) return;
        retryStarted = true;
        const current = projects.getOwned(view.sessionId, 20).aggregate;
        const input = {
          ...draftInput(view.sessionId),
          expectedRevision: current.revision,
          ...(current.latestVersionId === null
            ? {}
            : {
                kind: 'aiReview' as const,
                parentVersionId: current.latestVersionId,
              }),
        };
        retry = tasks.start(input, 20);
        resolveTerminal();
      });
      const firstInput = {
        ...draftInput(view.sessionId),
        ...(terminalStatus === 'timedOut' ? { taskConfig: { requestTimeoutMs: 1_000 } } : {}),
      };
      const firstTask = await tasks.start(firstInput, 20);
      if (terminalStatus === 'cancelled') {
        await firstPending!.started;
        const current = projects.getOwned(view.sessionId, 20).aggregate;
        await tasks.cancel(
          {
            sessionId: view.sessionId,
            expectedRevision: current.revision,
            taskId: firstTask.id,
          },
          20,
        );
      }
      await terminal;
      if (retry === undefined) throw new Error('terminal event did not start retry');
      await retry;
      await secondRunner.started;
      const current = projects.getOwned(view.sessionId, 20).aggregate;
      const secondTask = current.tasks.at(-1)!;
      await tasks.cancel(
        {
          sessionId: view.sessionId,
          expectedRevision: current.revision,
          taskId: secondTask.id,
        },
        20,
      );
      await tasks.shutdownAll();
      await projects.closeAll();
    },
  );

  it('does not queue or spawn when credentials are unavailable', async () => {
    const runner = new PendingRunner();
    const { projects, tasks, view } = await setup(runner, async () => {
      throw new Error('unavailable');
    });
    await expect(tasks.start(draftInput(view.sessionId), 20)).rejects.toThrow('unavailable');
    expect(projects.getOwned(view.sessionId, 20).aggregate.tasks).toHaveLength(0);
    expect(runner.starts).toBe(0);
    await projects.closeAll();
  });

  it('linearizes credential persistence before a competing task queue', async () => {
    const candidate = 'candidate-credential';
    let configuredKey: string | undefined = 'old-credential';
    const gate = new SerialLinearizationGate();
    const runner = new PendingRunner();
    const { projects, tasks, view } = await setup(
      runner,
      async () => configuredKey ?? 'old-credential',
      { gate, readConfiguredApiKey: async () => configuredKey },
    );
    let releasePersist!: () => void;
    const persistGate = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    let resolvePersisting!: () => void;
    const persisting = new Promise<void>((resolve) => {
      resolvePersisting = resolve;
    });
    const setKey = projects.setCredentialIfProjectsSafe(candidate, async () => {
      resolvePersisting();
      await persistGate;
      configuredKey = candidate;
      return true;
    });
    await persisting;
    const input = draftInput(view.sessionId);
    input.messages[0] = { role: 'user', content: `prompt ${candidate}` };
    const start = tasks.start(input, 20);
    releasePersist();
    await expect(setKey).resolves.toBe(true);
    await expect(start).rejects.toMatchObject({ safe: { code: 'CONTENT_INVALID' } });
    const aggregate = projects.getOwned(view.sessionId, 20).aggregate;
    expect(aggregate.revision).toBe(0);
    expect(aggregate.prompts).toHaveLength(0);
    expect(aggregate.tasks).toHaveLength(0);
    expect(runner.starts).toBe(0);
    await projects.closeAll();
  });

  it('linearizes task completion before a competing credential replacement', async () => {
    const candidate = 'candidate-credential';
    let configuredKey: string | undefined = 'old-credential';
    const gate = new SerialLinearizationGate();
    const runner = new DeferredCredentialRunner();
    const { projects, tasks, view } = await setup(
      runner,
      async () => configuredKey ?? 'old-credential',
      { gate, readConfiguredApiKey: async () => configuredKey },
    );
    let savingReached = false;
    let releaseCompletion!: () => void;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    let resolveBlocked!: () => void;
    const completionBlocked = new Promise<void>((resolve) => {
      resolveBlocked = resolve;
    });
    tasks.setListener(20, (event) => {
      if (event.status === 'saving') savingReached = true;
    });
    let injected = false;
    setCommitBarrierForTest(async (barrier) => {
      if (savingReached && !injected && barrier === 'afterHeadReplace') {
        injected = true;
        resolveBlocked();
        await completionGate;
        throw new Error('synthetic post-head completion response loss');
      }
    });
    await tasks.start(draftInput(view.sessionId), 20);
    await runner.started;
    runner.complete(
      `Synthetic activity completed\nThe report contains ${candidate} and sufficient body detail.`,
    );
    await completionBlocked;
    let authWrites = 0;
    const setKey = projects.setCredentialIfProjectsSafe(candidate, async () => {
      authWrites += 1;
      configuredKey = candidate;
      return true;
    });
    const setKeyRejected = expect(setKey).rejects.toMatchObject({
      safe: { code: 'CONTENT_INVALID' },
    });
    releaseCompletion();
    await tasks.shutdownAll();
    await setKeyRejected;
    const aggregate = projects.getOwned(view.sessionId, 20).aggregate;
    expect(injected).toBe(true);
    expect(aggregate.tasks[0]?.status).toBe('succeeded');
    expect(aggregate.versions).toHaveLength(1);
    expect(projects.view(view.sessionId, 20).versions[0]?.content).toContain(candidate);
    expect(authWrites).toBe(0);
    expect(configuredKey).toBe('old-credential');
    setCommitBarrierForTest();
    await projects.closeAll();
  });

  it('rejects a worker result containing a candidate key linearized during processing', async () => {
    const candidate = 'candidate-credential';
    let configuredKey: string | undefined = 'old-credential';
    const gate = new SerialLinearizationGate();
    const runner = new DeferredCredentialRunner();
    const { projects, tasks, view } = await setup(
      runner,
      async () => configuredKey ?? 'old-credential',
      { gate, readConfiguredApiKey: async () => configuredKey },
    );
    let resolveProcessing!: () => void;
    const processing = new Promise<void>((resolve) => {
      resolveProcessing = resolve;
    });
    let resolveTerminal!: (status: string) => void;
    const terminal = new Promise<string>((resolve) => {
      resolveTerminal = resolve;
    });
    tasks.setListener(20, (event) => {
      if (event.status === 'processing') resolveProcessing();
      if (['succeeded', 'failed', 'cancelled', 'timedOut'].includes(event.status)) {
        resolveTerminal(event.status);
      }
    });
    await tasks.start(draftInput(view.sessionId), 20);
    await runner.started;
    await processing;
    await expect(
      projects.setCredentialIfProjectsSafe(candidate, async () => {
        configuredKey = candidate;
        return true;
      }),
    ).resolves.toBe(true);
    runner.complete(
      `Synthetic activity completed\nThe report contains ${candidate} and sufficient body detail.`,
    );
    await expect(terminal).resolves.toBe('failed');
    const aggregate = projects.getOwned(view.sessionId, 20).aggregate;
    expect(aggregate.tasks[0]).toMatchObject({
      status: 'failed',
      error: { code: 'CONTENT_INVALID' },
    });
    expect(aggregate.versions).toHaveLength(0);
    expect(aggregate.latestVersionId).toBeNull();
    expect(configuredKey).toBe(candidate);
    await tasks.shutdownAll();
    await projects.closeAll();
  });

  it.each([
    ['s', 'k-', 'abcdefghijklmnop'].join(''),
    ['S', 'K-', 'ABCDEFGHIJKLMNOP'].join(''),
    ['Bearer', ' ', 'ABCDEFGHIJKLMNOP'].join(''),
    'synthetic-credential',
  ])('blocks credential material before queue or worker start: %s', async (secret) => {
    const runner = new PendingRunner();
    const { projects, tasks, view } = await setup(runner);
    const input = draftInput(view.sessionId);
    input.messages[0] = { role: 'user', content: `消息包含 ${secret}` };
    await expect(tasks.start(input, 20)).rejects.toMatchObject({
      safe: { code: 'CONTENT_INVALID' },
    });
    const aggregate = projects.getOwned(view.sessionId, 20).aggregate;
    expect(aggregate.revision).toBe(0);
    expect(aggregate.prompts).toHaveLength(0);
    expect(aggregate.tasks).toHaveLength(0);
    expect(runner.starts).toBe(0);
    await projects.closeAll();
  });

  it('maps unsupported project and task model configuration before queueing', async () => {
    for (const source of ['project', 'task'] as const) {
      const runner = new PendingRunner();
      const { projects, tasks, view } = await setup(runner);
      let expectedRevision = 0;
      if (source === 'project') {
        const updated = await projects.updateConfig(
          {
            sessionId: view.sessionId,
            expectedRevision,
            config: { model: 'unsupported-model' },
          },
          20,
        );
        expectedRevision = updated.revision;
      }
      const input = {
        ...draftInput(view.sessionId),
        expectedRevision,
        ...(source === 'task' ? { taskConfig: { model: 'unsupported-model' } } : {}),
      };
      await expect(tasks.start(input, 20)).rejects.toMatchObject({
        safe: { code: 'IPC_PROTOCOL_INVALID' },
      });
      const aggregate = projects.getOwned(view.sessionId, 20).aggregate;
      expect(aggregate.prompts).toHaveLength(0);
      expect(aggregate.tasks).toHaveLength(0);
      expect(runner.starts).toBe(0);
      await projects.closeAll();
    }
  });
});
