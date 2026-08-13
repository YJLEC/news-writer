import { taskIdSchema, type SafeAppError } from '@news-writer/shared';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { ChatCompletionInput, ChatCompletionResult } from './contracts';
import {
  AiTaskCoordinator,
  type TaskArbitrationCommand,
  type TaskArbitrationWinner,
  type TaskExecutionPort,
} from './execution';
import { AiSafeError, makeSafeError } from './errors';
import { NodeWorkerRunner, type WorkerRun, type WorkerRunner } from './worker';

const taskId = taskIdSchema.parse('00000000-0000-4000-8000-000000000001');
const input = (content = 'prompt'): ChatCompletionInput => ({
  model: 'deepseek-v4-pro',
  messages: [{ role: 'user', content }],
  reasoningEffort: 'medium',
  maxWords: 900,
});
const completion: ChatCompletionResult = {
  id: 'completion-1',
  model: 'deepseek-v4-pro',
  content: 'Synthetic report',
  finishReason: 'stop',
};
const acceptAll = {
  accept: (result: ChatCompletionResult): Promise<ChatCompletionResult> => Promise.resolve(result),
};

class DeferredRunner implements WorkerRunner {
  resolve!: (result: ChatCompletionResult) => void;
  reject!: (error: unknown) => void;
  status!: (status: 'requesting' | 'processing') => void;
  cancelled = 0;
  terminated = 0;
  starts = 0;

  run(
    _taskId: typeof taskId,
    _input: ChatCompletionInput,
    _apiKey: string,
    onStatus: (status: 'requesting' | 'processing') => void,
  ): WorkerRun {
    this.starts += 1;
    this.status = onStatus;
    return {
      result: new Promise((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
      }),
      cancel: () => {
        this.cancelled += 1;
      },
      shutdown: () => {
        this.terminated += 1;
        return Promise.resolve();
      },
      terminate: () => {
        this.terminated += 1;
        return Promise.resolve(0);
      },
    };
  }
}

class RecordingPort implements TaskExecutionPort {
  readonly events: string[] = [];
  beforeArbitrate: (command: TaskArbitrationCommand) => Promise<void> = () => Promise.resolve();
  #winner: Exclude<TaskArbitrationWinner, 'conflict'> | undefined;
  #tail = Promise.resolve();

  transition(status: 'preparing' | 'requesting' | 'processing'): Promise<void> {
    this.events.push(status);
    return Promise.resolve();
  }
  fail(status: 'failed', error: SafeAppError): Promise<void> {
    this.events.push(`${status}:${error.code}`);
    return Promise.resolve();
  }

  async arbitrateTask(command: TaskArbitrationCommand): Promise<TaskArbitrationWinner> {
    this.events.push(`${command.kind}:entered`);
    await this.beforeArbitrate(command);
    const operation = this.#tail.then(() => {
      if (this.#winner !== undefined) return this.#winner;
      this.#winner =
        command.kind === 'save' ? 'saving' : command.kind === 'cancel' ? 'cancelled' : 'timedOut';
      this.events.push(
        command.kind === 'save'
          ? `saving:${command.result.content}`
          : `${this.#winner}:${command.error.code}`,
      );
      return this.#winner;
    });
    this.#tail = operation.then(() => undefined);
    return await operation;
  }

  holdProjectLock(): () => void {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tail = this.#tail.then(async () => await barrier);
    return release;
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

describe('AI task coordinator arbitration', () => {
  it('commits ordered observable states and hands one candidate to saving', async () => {
    const runner = new DeferredRunner();
    const port = new RecordingPort();
    const execution = new AiTaskCoordinator({ runner }).execute({
      taskId,
      input: input(),
      apiKey: 'test-credential',
      requestTimeoutMs: 10_000,
      contentAcceptance: acceptAll,
      port,
    });
    await vi.waitFor(() => expect(port.events).toEqual(['preparing']));
    runner.status('requesting');
    runner.status('processing');
    runner.resolve(completion);
    await expect(execution.outcome).resolves.toEqual({ status: 'saving', result: completion });
    expect(port.events).toEqual([
      'preparing',
      'requesting',
      'processing',
      'save:entered',
      'saving:Synthetic report',
    ]);
    await expect(execution.cancel()).resolves.toBe('savingOrFinished');
    expect(runner.terminated).toBe(1);
  });

  it('lets cancellation win before response validation and records one terminal state', async () => {
    const runner = new DeferredRunner();
    const port = new RecordingPort();
    const execution = new AiTaskCoordinator({ runner }).execute({
      taskId,
      input: input(),
      apiKey: 'test-credential',
      requestTimeoutMs: 10_000,
      contentAcceptance: acceptAll,
      port,
    });
    await vi.waitFor(() => expect(port.events).toEqual(['preparing']));
    const firstCancel = execution.cancel();
    await expect(execution.cancel()).resolves.toBe('alreadyRequested');
    await expect(firstCancel).resolves.toBe('accepted');
    await expect(execution.outcome).resolves.toMatchObject({
      status: 'cancelled',
      error: { code: 'REQUEST_CANCELLED' },
    });
    runner.resolve(completion);
    await Promise.resolve();
    expect(port.events.filter((event) => /cancelled|failed|timedOut|saving/.test(event))).toEqual([
      'cancelled:REQUEST_CANCELLED',
    ]);
  });

  it('does not start a worker when immediate cancellation queues behind preparing commit', async () => {
    const runner = new DeferredRunner();
    const events: string[] = [];
    let releasePreparing!: () => void;
    const preparingBarrier = new Promise<void>((resolve) => {
      releasePreparing = resolve;
    });
    let preparingEntered!: () => void;
    const enteredPreparing = new Promise<void>((resolve) => {
      preparingEntered = resolve;
    });
    let hostTail = Promise.resolve();
    const serialize = <Result>(operation: () => Promise<Result>): Promise<Result> => {
      const result = hostTail.then(operation);
      hostTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    const port: TaskExecutionPort = {
      transition: (status) =>
        serialize(async () => {
          if (status === 'preparing') {
            preparingEntered();
            await preparingBarrier;
          }
          events.push(status);
        }),
      fail: (status, error) => {
        events.push(`${status}:${error.code}`);
        return Promise.resolve();
      },
      arbitrateTask: (command) =>
        serialize(() => {
          if (command.kind !== 'cancel') return Promise.resolve('conflict');
          events.push(`cancelled:${command.error.code}`);
          return Promise.resolve('cancelled');
        }),
    };
    const execution = new AiTaskCoordinator({ runner }).execute({
      taskId,
      input: input(),
      apiKey: 'test-credential',
      requestTimeoutMs: 10_000,
      contentAcceptance: acceptAll,
      port,
    });
    await enteredPreparing;
    const cancellation = execution.cancel();
    releasePreparing();
    await expect(cancellation).resolves.toBe('accepted');
    await expect(execution.outcome).resolves.toMatchObject({ status: 'cancelled' });
    expect(runner.starts).toBe(0);
    expect(events).toEqual(['preparing', 'cancelled:REQUEST_CANCELLED']);
    expect(events).not.toContain('requesting');
  });

  it('lets the absolute deadline win and ignores a later response', async () => {
    const runner = new DeferredRunner();
    const port = new RecordingPort();
    const timer = new ManualTimer();
    const execution = new AiTaskCoordinator({ runner, timer }).execute({
      taskId,
      input: input(),
      apiKey: 'test-credential',
      requestTimeoutMs: 1_000,
      contentAcceptance: acceptAll,
      port,
    });
    await vi.waitFor(() => expect(port.events).toEqual(['preparing']));
    timer.fire();
    await expect(execution.outcome).resolves.toMatchObject({
      status: 'timedOut',
      error: { code: 'REQUEST_TIMEOUT' },
    });
    runner.resolve(completion);
    await Promise.resolve();
    expect(port.events).not.toContain('saving:Synthetic report');
  });

  it('lets timeout persist first after save enters the host but before save reaches the project lock', async () => {
    const runner = new DeferredRunner();
    const timer = new ManualTimer();
    let releaseSaving!: () => void;
    const savingBarrier = new Promise<void>((resolve) => {
      releaseSaving = resolve;
    });
    const port = new RecordingPort();
    port.beforeArbitrate = async (command) => {
      if (command.kind === 'save') await savingBarrier;
    };
    const execution = new AiTaskCoordinator({ runner, timer }).execute({
      taskId,
      input: input(),
      apiKey: 'test-credential',
      requestTimeoutMs: 1_000,
      contentAcceptance: acceptAll,
      port,
    });
    await vi.waitFor(() => expect(port.events).toEqual(['preparing']));
    runner.status('requesting');
    runner.status('processing');
    runner.resolve(completion);
    await vi.waitFor(() => expect(port.events).toContain('save:entered'));
    timer.fire();
    await vi.waitFor(() => expect(port.events).toContain('timedOut:REQUEST_TIMEOUT'));
    releaseSaving();
    await expect(execution.outcome).resolves.toMatchObject({ status: 'timedOut' });
    expect(port.events).not.toContain('saving:Synthetic report');
  });

  it('lets cancellation persist first after save enters the host but before save reaches the project lock', async () => {
    const runner = new DeferredRunner();
    let releaseSaving!: () => void;
    const savingBarrier = new Promise<void>((resolve) => {
      releaseSaving = resolve;
    });
    const port = new RecordingPort();
    port.beforeArbitrate = async (command) => {
      if (command.kind === 'save') await savingBarrier;
    };
    const execution = new AiTaskCoordinator({ runner }).execute({
      taskId,
      input: input(),
      apiKey: 'test-credential',
      requestTimeoutMs: 10_000,
      contentAcceptance: acceptAll,
      port,
    });
    await vi.waitFor(() => expect(port.events).toEqual(['preparing']));
    runner.status('requesting');
    runner.status('processing');
    runner.resolve(completion);
    await vi.waitFor(() => expect(port.events).toContain('save:entered'));
    const cancellation = execution.cancel();
    await vi.waitFor(() => expect(port.events).toContain('cancelled:REQUEST_CANCELLED'));
    releaseSaving();
    await expect(cancellation).resolves.toBe('accepted');
    await expect(execution.outcome).resolves.toMatchObject({ status: 'cancelled' });
    expect(port.events).not.toContain('saving:Synthetic report');
  });

  it('returns savingOrFinished when save persists before a later cancellation', async () => {
    const runner = new DeferredRunner();
    const port = new RecordingPort();
    const execution = new AiTaskCoordinator({ runner }).execute({
      taskId,
      input: input(),
      apiKey: 'test-credential',
      requestTimeoutMs: 10_000,
      contentAcceptance: acceptAll,
      port,
    });
    await vi.waitFor(() => expect(port.events).toEqual(['preparing']));
    runner.resolve(completion);
    await vi.waitFor(() => expect(port.events).toContain('saving:Synthetic report'));
    await expect(execution.cancel()).resolves.toBe('savingOrFinished');
    await expect(execution.outcome).resolves.toMatchObject({ status: 'saving' });
  });

  it('uses one project-lock winner when save and cancel are both queued behind the lock', async () => {
    const runner = new DeferredRunner();
    const port = new RecordingPort();
    const releaseLock = port.holdProjectLock();
    const execution = new AiTaskCoordinator({ runner }).execute({
      taskId,
      input: input(),
      apiKey: 'test-credential',
      requestTimeoutMs: 10_000,
      contentAcceptance: acceptAll,
      port,
    });
    await vi.waitFor(() => expect(port.events).toEqual(['preparing']));
    runner.resolve(completion);
    await vi.waitFor(() => expect(port.events).toContain('save:entered'));
    const cancellation = execution.cancel();
    await vi.waitFor(() => expect(port.events).toContain('cancel:entered'));
    releaseLock();
    await expect(cancellation).resolves.toBe('savingOrFinished');
    await expect(execution.outcome).resolves.toMatchObject({ status: 'saving' });
    expect(port.events).toContain('saving:Synthetic report');
  });

  it('rejects instead of hanging when a terminal state cannot be committed', async () => {
    const runner = new DeferredRunner();
    const port = new RecordingPort();
    port.fail = () => Promise.reject(new Error('storage unavailable'));
    const execution = new AiTaskCoordinator({ runner }).execute({
      taskId,
      input: input(),
      apiKey: 'test-credential',
      requestTimeoutMs: 10_000,
      contentAcceptance: acceptAll,
      port,
    });
    await vi.waitFor(() => expect(port.events).toEqual(['preparing']));
    runner.reject(new Error('worker failed'));
    await expect(execution.outcome).rejects.toMatchObject({
      safe: { code: 'TASK_INTERRUPTED' },
    });
  });

  it('maps an unexpected worker failure and permits a subsequent task', async () => {
    const runner = new DeferredRunner();
    const port = new RecordingPort();
    const coordinator = new AiTaskCoordinator({ runner });
    const execution = coordinator.execute({
      taskId,
      input: input(),
      apiKey: 'test-credential',
      requestTimeoutMs: 10_000,
      contentAcceptance: acceptAll,
      port,
    });
    await vi.waitFor(() => expect(port.events).toEqual(['preparing']));
    runner.reject(new Error('private worker stack'));
    await expect(execution.outcome).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'TASK_INTERRUPTED' },
    });
    const nextRunner = new DeferredRunner();
    const next = new AiTaskCoordinator({ runner: nextRunner }).execute({
      taskId,
      input: input(),
      apiKey: 'test-credential',
      requestTimeoutMs: 10_000,
      contentAcceptance: acceptAll,
      port: new RecordingPort(),
    });
    await next.cancel();
    await expect(next.outcome).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('preserves an already-safe worker failure without retrying', async () => {
    const runner = new DeferredRunner();
    const port = new RecordingPort();
    const execution = new AiTaskCoordinator({ runner }).execute({
      taskId,
      input: input(),
      apiKey: 'test-credential',
      requestTimeoutMs: 10_000,
      contentAcceptance: acceptAll,
      port,
    });
    await vi.waitFor(() => expect(port.events).toEqual(['preparing']));
    runner.reject(
      makeSafeError('RATE_LIMITED', 'Rate limited', { retryable: true, httpStatus: 429 }),
    );
    await expect(execution.outcome).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'RATE_LIMITED', retryable: true },
    });
  });

  it.each([
    ['', 'AUTH_REQUIRED'],
    ['   ', 'AUTH_REQUIRED'],
    ['x'.repeat(4097), 'PROTOCOL_INVALID'],
  ])('rejects invalid credentials before spawning a worker', (apiKey, code) => {
    const runner = new DeferredRunner();
    expect(() =>
      new AiTaskCoordinator({ runner }).execute({
        taskId,
        input: input(),
        apiKey,
        requestTimeoutMs: 10_000,
        contentAcceptance: acceptAll,
        port: new RecordingPort(),
      }),
    ).toThrowError(AiSafeError);
    try {
      new AiTaskCoordinator({ runner }).execute({
        taskId,
        input: input(),
        apiKey,
        requestTimeoutMs: 10_000,
        contentAcceptance: acceptAll,
        port: new RecordingPort(),
      });
    } catch (error) {
      expect((error as AiSafeError).safe.code).toBe(code);
    }
    expect(runner.starts).toBe(0);
  });

  it('fails rejected product content before saving arbitration', async () => {
    const runner = new DeferredRunner();
    const port = new RecordingPort();
    const execution = new AiTaskCoordinator({ runner }).execute({
      taskId,
      input: input(),
      apiKey: 'test-credential',
      requestTimeoutMs: 10_000,
      contentAcceptance: {
        accept: () =>
          Promise.reject(
            new AiSafeError(
              makeSafeError('CONTENT_INVALID', 'The response is not a clean news article'),
            ),
          ),
      },
      port,
    });
    await vi.waitFor(() => expect(port.events).toEqual(['preparing']));
    runner.resolve({ ...completion, content: '问题清单：地点待补充' });
    await expect(execution.outcome).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'CONTENT_INVALID' },
    });
    expect(port.events.some((event) => event.startsWith('saving:'))).toBe(false);
  });
});

describe('real worker_threads runner', () => {
  const entry = pathToFileURL(path.resolve('tests/helpers/ai-worker.mjs'));

  it('validates real worker status and result messages and terminates cleanly', async () => {
    const statuses: string[] = [];
    const run = new NodeWorkerRunner(entry).run(taskId, input(), 'test-credential', (status) =>
      statuses.push(status),
    );
    await expect(run.result).resolves.toEqual(completionWithWorkerId());
    expect(statuses).toEqual(['requesting', 'processing']);
    await run.terminate();
  });

  it('maps nonzero worker exit and supports forced termination', async () => {
    const crash = new NodeWorkerRunner(entry).run(
      taskId,
      input('crash'),
      'test-credential',
      () => undefined,
    );
    await expect(crash.result).rejects.toMatchObject({ safe: { code: 'TASK_INTERRUPTED' } });
    const hang = new NodeWorkerRunner(entry).run(
      taskId,
      input('hang'),
      'test-credential',
      () => undefined,
    );
    const hangResult = expect(hang.result).rejects.toMatchObject({
      safe: { code: 'TASK_INTERRUPTED' },
    });
    await expect(hang.terminate()).resolves.toBeGreaterThanOrEqual(0);
    await hangResult;

    const cleanExit = new NodeWorkerRunner(entry).run(
      taskId,
      input('exit-zero'),
      'test-credential',
      () => undefined,
    );
    await expect(cleanExit.result).rejects.toMatchObject({
      safe: { code: 'TASK_INTERRUPTED', diagnosticId: 'worker_exit_0' },
    });
  });

  it('propagates cancellation and unexpected worker errors as safe failures', async () => {
    const cancel = new NodeWorkerRunner(entry).run(
      taskId,
      input('hang'),
      'test-credential',
      () => undefined,
    );
    cancel.cancel();
    await expect(cancel.result).rejects.toMatchObject({ safe: { code: 'REQUEST_CANCELLED' } });
    await cancel.terminate();

    const thrown = new NodeWorkerRunner(entry).run(
      taskId,
      input('throw'),
      'test-credential',
      () => undefined,
    );
    await expect(thrown.result).rejects.toMatchObject({ safe: { code: 'TASK_INTERRUPTED' } });
  });

  it.each(['malformed', 'extra', 'wrong-task', 'forged'])(
    'fails malformed or unowned worker event %s immediately',
    async (fixture) => {
      const run = new NodeWorkerRunner(entry).run(
        taskId,
        input(fixture),
        'test-credential',
        () => undefined,
      );
      await expect(run.result).rejects.toMatchObject({ safe: { code: 'PROTOCOL_INVALID' } });
      await run.terminate();
    },
  );

  it('validates the complete start command before spawning', () => {
    const runner = new NodeWorkerRunner(entry);
    for (const apiKey of ['', '   ']) {
      expect(() => runner.run(taskId, input(), apiKey, () => undefined)).toThrowError(AiSafeError);
    }
    expect(() => runner.run(taskId, input(), 'x'.repeat(4097), () => undefined)).toThrowError(
      AiSafeError,
    );
  });

  it('uses one awaitable grace shutdown when a worker ignores cancellation', async () => {
    const run = new NodeWorkerRunner(entry).run(
      taskId,
      input('ignore-cancel'),
      'test-credential',
      () => undefined,
    );
    const result = expect(run.result).rejects.toMatchObject({
      safe: { code: 'TASK_INTERRUPTED' },
    });
    const firstShutdown = run.shutdown(0);
    expect(run.shutdown(0)).toBe(firstShutdown);
    await firstShutdown;
    await result;
    await expect(run.terminate()).resolves.toBeGreaterThanOrEqual(0);
  });
});

const completionWithWorkerId = (): ChatCompletionResult => ({
  id: 'worker-completion',
  model: 'deepseek-v4-pro',
  content: 'Worker result',
  finishReason: 'stop',
});
