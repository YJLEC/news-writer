import {
  AiSafeError,
  makeSafeError,
  type ChatCompletionInput,
  type ChatCompletionResult,
  type WorkerRun,
  type WorkerRunner,
} from '@news-writer/ai';
import type { TaskId } from '@news-writer/shared';
import { z } from 'zod';

const delaySchema = z.number().int().min(0).max(30_000);
const timingSchema = {
  requestingAfterMs: delaySchema.default(0),
  processingAfterMs: delaySchema.default(0),
  settleAfterMs: delaySchema.default(0),
};
const resultFields = {
  content: z.string().max(200_000),
  completionId: z.string().min(1).max(128),
  promptTokens: z.number().int().nonnegative().max(1_000_000).default(10),
  completionTokens: z.number().int().nonnegative().max(1_000_000).default(20),
};
const stepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('success'), ...timingSchema, ...resultFields }).strict(),
  z.object({ type: z.literal('delayedSuccess'), ...timingSchema, ...resultFields }).strict(),
  z
    .object({
      type: z.literal('safeFailure'),
      ...timingSchema,
      code: z.enum([
        'AUTH_REJECTED',
        'INSUFFICIENT_BALANCE',
        'RATE_LIMITED',
        'NETWORK_UNAVAILABLE',
        'SERVICE_UNAVAILABLE',
        'PROTOCOL_INVALID',
        'TASK_INTERRUPTED',
      ]),
    })
    .strict(),
  z.object({ type: z.literal('empty'), ...timingSchema }).strict(),
  z.object({ type: z.literal('invalidContent'), ...timingSchema }).strict(),
  z.object({ type: z.literal('hang'), ...timingSchema }).strict(),
]);

export const controlledPlanSchema = z
  .object({
    schema: z.literal('news-writer-controlled-ai-plan-v1'),
    steps: z.array(stepSchema).min(1).max(16),
  })
  .strict();

export type ControlledPlan = z.infer<typeof controlledPlanSchema>;
type ControlledStep = ControlledPlan['steps'][number];

const interrupted = () =>
  new AiSafeError(makeSafeError('TASK_INTERRUPTED', 'The controlled AI run was stopped'));

export const parseControlledPlan = (raw: string | undefined): ControlledPlan => {
  if (raw === undefined || Buffer.byteLength(raw, 'utf8') > 256 * 1024) {
    throw new Error('Invalid controlled AI startup plan.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid controlled AI startup plan.');
  }
  const result = controlledPlanSchema.safeParse(parsed);
  if (!result.success) throw new Error('Invalid controlled AI startup plan.');
  return result.data;
};

export class ControlledMockWorkerRunner implements WorkerRunner {
  readonly #steps: ControlledStep[];
  #next = 0;

  constructor(plan: ControlledPlan) {
    this.#steps = [...plan.steps];
  }

  run(
    _taskId: TaskId,
    input: ChatCompletionInput,
    apiKey: string,
    onStatus: (status: 'requesting' | 'processing') => void,
  ): WorkerRun {
    if (apiKey.trim().length === 0 || apiKey.length > 4096) {
      throw new AiSafeError(makeSafeError('PROTOCOL_INVALID', 'Invalid test credential'));
    }
    const step = this.#steps[this.#next++];
    if (step === undefined) {
      throw new AiSafeError(
        makeSafeError('TASK_INTERRUPTED', 'The controlled AI plan was exhausted'),
      );
    }

    const handles = new Set<ReturnType<typeof setTimeout>>();
    let settled = false;
    let stopped = false;
    let resolveResult!: (result: ChatCompletionResult) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<ChatCompletionResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const schedule = (callback: () => void, milliseconds: number): void => {
      const handle = setTimeout(() => {
        handles.delete(handle);
        if (!stopped) callback();
      }, milliseconds);
      handles.add(handle);
    };
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      for (const handle of handles) clearTimeout(handle);
      handles.clear();
    };
    const resolve = (value: ChatCompletionResult): void => {
      if (settled || stopped) return;
      settled = true;
      resolveResult(value);
    };
    const reject = (error: Error): void => {
      if (settled || stopped) return;
      settled = true;
      rejectResult(error);
    };
    const requestingAt = step.requestingAfterMs;
    const processingAt = requestingAt + step.processingAfterMs;
    const settleAt = processingAt + step.settleAfterMs;
    schedule(() => onStatus('requesting'), requestingAt);
    schedule(() => onStatus('processing'), processingAt);

    if (step.type === 'safeFailure') {
      schedule(
        () => reject(new AiSafeError(makeSafeError(step.code, 'Controlled AI failure'))),
        settleAt,
      );
    } else if (step.type !== 'hang') {
      const content =
        step.type === 'empty'
          ? ''
          : step.type === 'invalidContent'
            ? '待补充：受控无效内容'
            : step.content;
      const completionId =
        step.type === 'success' || step.type === 'delayedSuccess'
          ? step.completionId
          : 'controlled-rejection';
      const promptTokens =
        step.type === 'success' || step.type === 'delayedSuccess' ? step.promptTokens : 1;
      const completionTokens =
        step.type === 'success' || step.type === 'delayedSuccess' ? step.completionTokens : 0;
      schedule(
        () =>
          resolve({
            id: completionId,
            model: input.model,
            content,
            finishReason: 'stop',
            usage: {
              promptTokens,
              completionTokens,
              totalTokens: promptTokens + completionTokens,
            },
          }),
        settleAt,
      );
    }

    return {
      result,
      cancel: stop,
      shutdown: () => {
        stop();
        return Promise.resolve();
      },
      terminate: () => {
        stop();
        if (!settled) {
          settled = true;
          rejectResult(interrupted());
        }
        return Promise.resolve(0);
      },
    };
  }
}
