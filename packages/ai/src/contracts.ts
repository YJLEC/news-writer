import { safeAppErrorSchema, taskIdSchema } from '@news-writer/shared';
import { z } from 'zod';

export const deepSeekModelSchema = z.enum(['deepseek-v4-flash', 'deepseek-v4-pro']);
export type DeepSeekModel = z.infer<typeof deepSeekModelSchema>;

export const chatMessageSchema = z
  .object({
    role: z.enum(['system', 'user']),
    content: z.string().min(1).max(1_000_000),
  })
  .strict();

export const reasoningEffortSchema = z.enum(['off', 'low', 'medium', 'high']);

export const chatCompletionInputSchema = z
  .object({
    model: deepSeekModelSchema,
    messages: z.array(chatMessageSchema).min(1).max(16),
    reasoningEffort: reasoningEffortSchema,
    maxWords: z.number().int().min(100).max(10_000),
  })
  .strict();

export type ChatCompletionInput = z.infer<typeof chatCompletionInputSchema>;

export const chatCompletionResultSchema = z
  .object({
    id: z.string().min(1).max(256),
    model: z.string().min(1).max(128),
    content: z
      .string()
      .min(1)
      .max(8 * 1024 * 1024),
    finishReason: z.literal('stop'),
    usage: z
      .object({
        promptTokens: z.number().int().nonnegative(),
        completionTokens: z.number().int().nonnegative(),
        totalTokens: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ChatCompletionResult = z.infer<typeof chatCompletionResultSchema>;

export interface ChatCompletionPort {
  complete(
    input: ChatCompletionInput,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<ChatCompletionResult>;
}

export const workerStartMessageSchema = z
  .object({
    type: z.literal('start'),
    taskId: taskIdSchema,
    apiKey: z.string().min(1).max(4096),
    input: chatCompletionInputSchema,
  })
  .strict();

export const workerCancelMessageSchema = z
  .object({ type: z.literal('cancel'), taskId: taskIdSchema })
  .strict();

export const workerCommandSchema = z.discriminatedUnion('type', [
  workerStartMessageSchema,
  workerCancelMessageSchema,
]);

export const workerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('requesting'), taskId: taskIdSchema }).strict(),
  z.object({ type: z.literal('processing'), taskId: taskIdSchema }).strict(),
  z
    .object({
      type: z.literal('completed'),
      taskId: taskIdSchema,
      result: chatCompletionResultSchema,
    })
    .strict(),
  z.object({ type: z.literal('failed'), taskId: taskIdSchema, error: safeAppErrorSchema }).strict(),
]);

export type WorkerCommand = z.infer<typeof workerCommandSchema>;
export type WorkerEvent = z.infer<typeof workerEventSchema>;
