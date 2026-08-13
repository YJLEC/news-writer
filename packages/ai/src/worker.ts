import { Worker } from 'node:worker_threads';

import {
  workerEventSchema,
  workerStartMessageSchema,
  type ChatCompletionInput,
  type ChatCompletionResult,
  type WorkerEvent,
} from './contracts.js';
import { AiSafeError, makeSafeError } from './errors.js';

export interface WorkerRun {
  result: Promise<ChatCompletionResult>;
  cancel(): void;
  shutdown(graceMs: number): Promise<void>;
  terminate(): Promise<number>;
}

export interface WorkerRunner {
  run(
    taskId: WorkerEvent['taskId'],
    input: ChatCompletionInput,
    apiKey: string,
    onStatus: (status: 'requesting' | 'processing') => void,
  ): WorkerRun;
}

const workerEntryUrl = (): URL =>
  import.meta.url.endsWith('.ts')
    ? new URL('../dist/worker-entry.js', import.meta.url)
    : new URL('./worker-entry.js', import.meta.url);

const interrupted = (diagnosticId?: string): AiSafeError =>
  new AiSafeError(
    makeSafeError('TASK_INTERRUPTED', 'The AI worker stopped unexpectedly', {
      retryable: true,
      ...(diagnosticId === undefined ? {} : { diagnosticId }),
    }),
  );

const protocolFailure = (): AiSafeError =>
  new AiSafeError(makeSafeError('PROTOCOL_INVALID', 'The AI worker returned an invalid message'));

export class NodeWorkerRunner implements WorkerRunner {
  readonly #entryUrl: URL;

  constructor(entryUrl: URL = workerEntryUrl()) {
    this.#entryUrl = entryUrl;
  }

  run(
    taskId: WorkerEvent['taskId'],
    input: ChatCompletionInput,
    apiKey: string,
    onStatus: (status: 'requesting' | 'processing') => void,
  ): WorkerRun {
    if (apiKey.trim().length === 0) {
      throw new AiSafeError(makeSafeError('AUTH_REQUIRED', 'An API credential is required'));
    }
    if (apiKey.length > 4096) {
      throw new AiSafeError(
        makeSafeError('PROTOCOL_INVALID', 'The API credential format is invalid'),
      );
    }
    const command = workerStartMessageSchema.safeParse({ type: 'start', taskId, input, apiKey });
    if (!command.success) {
      throw new AiSafeError(
        makeSafeError(
          apiKey.trim().length === 0 ? 'AUTH_REQUIRED' : 'PROTOCOL_INVALID',
          apiKey.trim().length === 0
            ? 'An API credential is required'
            : 'The AI worker command is invalid',
        ),
      );
    }

    const worker = new Worker(this.#entryUrl);
    let exited = false;
    let terminalEvent = false;
    let terminatePromise: Promise<number> | undefined;
    let shutdownPromise: Promise<void> | undefined;
    let resolveExit!: (code: number) => void;
    const exit = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    let resolveResult!: (result: ChatCompletionResult) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<ChatCompletionResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const terminateOnce = (): Promise<number> => {
      if (terminatePromise !== undefined) return terminatePromise;
      terminatePromise = exited ? exit : worker.terminate();
      return terminatePromise;
    };
    const settle = (value: ChatCompletionResult | AiSafeError): void => {
      if (terminalEvent) return;
      terminalEvent = true;
      void terminateOnce().then(
        () => {
          if (value instanceof AiSafeError) rejectResult(value);
          else resolveResult(value);
        },
        () => rejectResult(interrupted('worker_termination_failed')),
      );
    };

    worker.on('message', (raw: unknown) => {
      if (terminalEvent) return;
      const event = workerEventSchema.safeParse(raw);
      if (!event.success || event.data.taskId !== taskId) {
        settle(protocolFailure());
        return;
      }
      if (event.data.type === 'requesting' || event.data.type === 'processing') {
        onStatus(event.data.type);
      } else if (event.data.type === 'completed') {
        settle(event.data.result);
      } else {
        settle(new AiSafeError(event.data.error));
      }
    });
    worker.once('error', () => settle(interrupted('worker_error')));
    worker.once('exit', (code: number) => {
      exited = true;
      resolveExit(code);
      if (!terminalEvent) {
        terminalEvent = true;
        rejectResult(interrupted(`worker_exit_${code}`));
      }
    });
    worker.postMessage(command.data);

    return {
      result,
      cancel: () => {
        if (!exited && !terminalEvent) worker.postMessage({ type: 'cancel', taskId });
      },
      shutdown: (graceMs: number) => {
        if (shutdownPromise !== undefined) return shutdownPromise;
        shutdownPromise = (async () => {
          if (exited) return;
          if (!terminalEvent) worker.postMessage({ type: 'cancel', taskId });
          let graceHandle: ReturnType<typeof setTimeout> | undefined;
          const grace = new Promise<'grace'>((resolve) => {
            graceHandle = setTimeout(() => resolve('grace'), Math.max(0, graceMs));
          });
          const winner = await Promise.race([exit.then(() => 'exit' as const), grace]);
          if (graceHandle !== undefined) clearTimeout(graceHandle);
          if (winner === 'grace') await terminateOnce();
          await exit;
        })();
        return shutdownPromise;
      },
      terminate: terminateOnce,
    };
  }
}
