import { safeAppErrorSchema, type SafeAppError, type TaskId } from '@news-writer/shared';

import { type ContentAcceptancePort } from './content.js';
import {
  chatCompletionInputSchema,
  type ChatCompletionInput,
  type ChatCompletionResult,
} from './contracts.js';
import { AiSafeError, makeSafeError } from './errors.js';
import { NodeWorkerRunner, type WorkerRun, type WorkerRunner } from './worker.js';

export type ExecutionStatus = 'preparing' | 'requesting' | 'processing';
export type TaskArbitrationWinner = 'saving' | 'cancelled' | 'timedOut' | 'conflict';
export type TaskArbitrationCommand =
  | { kind: 'save'; result: ChatCompletionResult }
  | { kind: 'cancel'; error: SafeAppError }
  | { kind: 'timeout'; error: SafeAppError };

export interface TaskExecutionPort {
  transition(status: ExecutionStatus): Promise<void>;
  fail(status: 'failed', error: SafeAppError): Promise<void>;
  arbitrateTask(command: TaskArbitrationCommand): Promise<TaskArbitrationWinner>;
}

export interface ExecuteTaskInput {
  taskId: TaskId;
  input: ChatCompletionInput;
  apiKey: string;
  requestTimeoutMs: number;
  contentAcceptance: ContentAcceptancePort;
  port: TaskExecutionPort;
}

export type ExecutionOutcome =
  | { status: 'saving'; result: ChatCompletionResult }
  | { status: 'failed' | 'cancelled' | 'timedOut'; error: SafeAppError };

export interface TaskExecution {
  outcome: Promise<ExecutionOutcome>;
  cancel(): Promise<'accepted' | 'alreadyRequested' | 'savingOrFinished'>;
}

interface TimerPort {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
}

const nativeTimer: TimerPort = {
  set: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface CoordinatorOptions {
  runner?: WorkerRunner;
  timer?: TimerPort;
  workerGraceMs?: number;
}

const safeExecutionError = (error: unknown): SafeAppError => {
  if (error instanceof AiSafeError) return error.safe;
  const parsed = safeAppErrorSchema.safeParse(error);
  return parsed.success
    ? parsed.data
    : makeSafeError('TASK_INTERRUPTED', 'The AI task stopped unexpectedly', { retryable: true });
};

const cancellationError = (): SafeAppError =>
  makeSafeError('REQUEST_CANCELLED', 'The request was cancelled', { retryable: true });
const timeoutError = (): SafeAppError =>
  makeSafeError('REQUEST_TIMEOUT', 'The AI request timed out', { retryable: true });

export class AiTaskCoordinator {
  readonly #runner: WorkerRunner;
  readonly #timer: TimerPort;
  readonly #workerGraceMs: number;
  #active = false;

  constructor(options: CoordinatorOptions = {}) {
    this.#runner = options.runner ?? new NodeWorkerRunner();
    this.#timer = options.timer ?? nativeTimer;
    this.#workerGraceMs = options.workerGraceMs ?? 250;
  }

  execute(raw: ExecuteTaskInput): TaskExecution {
    if (this.#active) throw new Error('AiTaskCoordinator already has an active task');
    const parsedInput = chatCompletionInputSchema.safeParse(raw.input);
    if (!parsedInput.success) {
      throw new AiSafeError(
        makeSafeError('PROTOCOL_INVALID', 'The AI task configuration is invalid'),
      );
    }
    if (
      !Number.isInteger(raw.requestTimeoutMs) ||
      raw.requestTimeoutMs < 1_000 ||
      raw.requestTimeoutMs > 600_000
    ) {
      throw new AiSafeError(makeSafeError('PROTOCOL_INVALID', 'The request timeout is invalid'));
    }
    if (raw.apiKey.trim().length === 0) {
      throw new AiSafeError(makeSafeError('AUTH_REQUIRED', 'An API credential is required'));
    }
    if (raw.apiKey.length > 4096) {
      throw new AiSafeError(
        makeSafeError('PROTOCOL_INVALID', 'The API credential format is invalid'),
      );
    }
    this.#active = true;

    const input = parsedInput.data;
    let phase: 'starting' | ExecutionStatus | 'arbitrating' | 'saving' | 'finished' = 'starting';
    let workerRun: WorkerRun | undefined;
    let timerHandle: unknown;
    let chain = Promise.resolve();
    let terminalCommand: Promise<TaskArbitrationWinner> | undefined;
    let cancelStarted = false;
    let resolveOutcome!: (value: ExecutionOutcome) => void;
    let rejectOutcome!: (error: unknown) => void;
    const outcome = new Promise<ExecutionOutcome>((resolve, reject) => {
      resolveOutcome = resolve;
      rejectOutcome = reject;
    });

    const clearDeadline = (): void => {
      if (timerHandle !== undefined) {
        this.#timer.clear(timerHandle);
        timerHandle = undefined;
      }
    };
    const isFinished = (): boolean => phase === 'finished';
    const isTerminal = (): boolean => phase === 'saving' || phase === 'finished';
    const shutdownWorker = async (): Promise<void> => {
      if (workerRun !== undefined) await workerRun.shutdown(this.#workerGraceMs);
    };
    const rejectUnknownState = async (): Promise<void> => {
      if (phase === 'finished') return;
      phase = 'finished';
      clearDeadline();
      await shutdownWorker().catch(() => undefined);
      this.#active = false;
      rejectOutcome(
        new AiSafeError(
          makeSafeError('TASK_INTERRUPTED', 'The task state could not be committed', {
            retryable: true,
          }),
        ),
      );
    };
    const finishFailed = async (error: SafeAppError): Promise<void> => {
      if (phase === 'saving' || phase === 'finished') return;
      phase = 'finished';
      clearDeadline();
      try {
        await shutdownWorker();
        await raw.port.fail('failed', error);
        this.#active = false;
        resolveOutcome({ status: 'failed', error });
      } catch {
        this.#active = false;
        rejectOutcome(
          new AiSafeError(
            makeSafeError('TASK_INTERRUPTED', 'The task state could not be committed', {
              retryable: true,
            }),
          ),
        );
      }
    };
    const completeWinner = async (
      winner: Exclude<TaskArbitrationWinner, 'conflict'>,
      result?: ChatCompletionResult,
    ): Promise<void> => {
      if (phase === 'finished') return;
      clearDeadline();
      await shutdownWorker();
      this.#active = false;
      if (winner === 'saving') {
        if (result === undefined) {
          await rejectUnknownState();
          return;
        }
        phase = 'saving';
        resolveOutcome({ status: 'saving', result });
      } else {
        phase = 'finished';
        const error = winner === 'cancelled' ? cancellationError() : timeoutError();
        resolveOutcome({ status: winner, error });
      }
    };
    const enqueue = (operation: () => Promise<void>): void => {
      chain = chain.then(operation).catch(async () => await rejectUnknownState());
    };
    const submitTerminal = (kind: 'cancel' | 'timeout'): Promise<TaskArbitrationWinner> => {
      if (terminalCommand !== undefined) return terminalCommand;
      workerRun?.cancel();
      const error = kind === 'cancel' ? cancellationError() : timeoutError();
      terminalCommand = raw.port
        .arbitrateTask({ kind, error })
        .then(async (winner) => {
          if (winner === 'cancelled' || winner === 'timedOut') await completeWinner(winner);
          else if (winner === 'conflict') await rejectUnknownState();
          return winner;
        })
        .catch(async () => {
          await rejectUnknownState();
          return 'conflict' as const;
        });
      return terminalCommand;
    };

    void (async () => {
      try {
        await raw.port.transition('preparing');
        if (terminalCommand !== undefined) {
          const winner = await terminalCommand;
          if (winner === 'saving' && !isFinished()) await rejectUnknownState();
          return;
        }
        if (isFinished()) return;
        phase = 'preparing';
        timerHandle = this.#timer.set(() => {
          if (phase === 'saving' || phase === 'finished') return;
          void submitTerminal('timeout');
        }, raw.requestTimeoutMs);
        workerRun = this.#runner.run(raw.taskId, input, raw.apiKey, (status) => {
          enqueue(async () => {
            if (phase === 'saving' || phase === 'finished') return;
            if (terminalCommand !== undefined) {
              await terminalCommand;
              return;
            }
            await raw.port.transition(status);
            if (!isTerminal()) phase = status;
          });
        });
        workerRun.result.then(
          (wireResult) => {
            enqueue(async () => {
              if (phase === 'saving' || phase === 'finished') return;
              if (terminalCommand !== undefined) {
                const winner = await terminalCommand;
                if (winner !== 'saving') return;
              }
              let result: ChatCompletionResult;
              try {
                result = await raw.contentAcceptance.accept(wireResult);
              } catch (error) {
                await finishFailed(safeExecutionError(error));
                return;
              }
              phase = 'arbitrating';
              let winner: TaskArbitrationWinner;
              try {
                winner = await raw.port.arbitrateTask({ kind: 'save', result });
              } catch {
                await rejectUnknownState();
                return;
              }
              if (winner === 'saving') await completeWinner('saving', result);
              else if (winner === 'cancelled' || winner === 'timedOut') {
                await completeWinner(winner);
              } else await rejectUnknownState();
            });
          },
          (error: unknown) => {
            enqueue(async () => {
              if (phase === 'finished') return;
              if (terminalCommand !== undefined) {
                const winner = await terminalCommand;
                if (winner === 'cancelled' || winner === 'timedOut' || isFinished()) return;
              }
              await finishFailed(safeExecutionError(error));
            });
          },
        );
      } catch (error) {
        await finishFailed(safeExecutionError(error));
      }
    })();

    return {
      outcome,
      cancel: async () => {
        if (phase === 'saving' || phase === 'finished') return 'savingOrFinished';
        if (cancelStarted) return 'alreadyRequested';
        cancelStarted = true;
        const winner = await submitTerminal('cancel');
        if (winner === 'saving') return 'savingOrFinished';
        if (winner === 'cancelled') return 'accepted';
        return 'alreadyRequested';
      },
    };
  }
}
