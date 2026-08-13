import { z } from 'zod';
import { containsSecretMaterial } from '@news-writer/shared';

import {
  chatCompletionInputSchema,
  chatCompletionResultSchema,
  type ChatCompletionInput,
  type ChatCompletionPort,
  type ChatCompletionResult,
} from './contracts.js';
import { AiSafeError, makeSafeError, throwSafe } from './errors.js';
import {
  NativeDeepSeekTransport,
  type JsonTransport,
  type TransportResponse,
} from './transport.js';

const finishReasonSchema = z.enum([
  'stop',
  'length',
  'content_filter',
  'insufficient_system_resource',
  'tool_calls',
]);

const wireUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().finite(),
  completion_tokens: z.number().int().nonnegative().finite(),
  total_tokens: z.number().int().nonnegative().finite(),
});

const wireResponseSchema = z.object({
  id: z.string().min(1).max(256),
  object: z.literal('chat.completion'),
  created: z.number().int().nonnegative().finite(),
  model: z.string().min(1).max(128),
  choices: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        message: z.object({
          role: z.literal('assistant'),
          content: z.string().nullable(),
          reasoning_content: z.string().nullable().optional(),
        }),
        finish_reason: finishReasonSchema,
      }),
    )
    .min(1),
  usage: wireUsageSchema.optional(),
});

// DeepSeek's reasoning tokens share the completion budget. Deriving this value
// from the prose target made otherwise valid responses end with finish_reason=length
// when the model spent more of the budget on reasoning. Keep the user's target
// length as a prompt guideline, but give the API the full supported output budget.
export const toMaxTokens = (maxWords: number): number => {
  void maxWords;
  return 32_768;
};

export const buildDeepSeekRequest = (inputValue: ChatCompletionInput) => {
  const input = chatCompletionInputSchema.parse(inputValue);
  return {
    model: input.model,
    messages: input.messages,
    stream: false as const,
    thinking: {
      type: input.reasoningEffort === 'off' ? ('disabled' as const) : ('enabled' as const),
    },
    ...(input.reasoningEffort === 'off' ? {} : { reasoning_effort: input.reasoningEffort }),
    max_tokens: toMaxTokens(input.maxWords),
  };
};

const parseRetryAfter = (value: string | null): number | undefined => {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return undefined;
  return Math.min(parsed, 86_400);
};

const httpError = (response: TransportResponse): never => {
  const retryAfterSeconds = parseRetryAfter(response.retryAfter);
  const options = {
    httpStatus: response.status,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
  if (response.status === 401) {
    throwSafe('AUTH_REJECTED', 'The AI service rejected the credential', options);
  }
  if (response.status === 402) {
    throwSafe('INSUFFICIENT_BALANCE', 'The AI service account has insufficient balance', options);
  }
  if (response.status === 429) {
    throwSafe('RATE_LIMITED', 'The AI service rate limit was reached', {
      ...options,
      retryable: true,
    });
  }
  if (response.status === 500 || response.status === 503) {
    throwSafe('SERVICE_UNAVAILABLE', 'The AI service is temporarily unavailable', {
      ...options,
      retryable: true,
    });
  }
  return throwSafe('PROTOCOL_INVALID', 'The AI service rejected the request', options);
};

const decodeJson = (response: TransportResponse): unknown => {
  if (response.status < 200 || response.status >= 300) httpError(response);
  if (response.contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throwSafe('PROTOCOL_INVALID', 'The AI service returned an unexpected content type');
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(response.body).trim();
    if (text.length === 0) throw new Error('empty');
    return JSON.parse(text) as unknown;
  } catch {
    throwSafe('PROTOCOL_INVALID', 'The AI service returned invalid JSON');
  }
};

export const parseDeepSeekResponse = (response: TransportResponse): ChatCompletionResult => {
  const parsed = wireResponseSchema.safeParse(decodeJson(response));
  if (!parsed.success || parsed.data.choices.length !== 1 || parsed.data.choices[0]?.index !== 0) {
    return throwSafe('PROTOCOL_INVALID', 'The AI service returned an invalid completion response');
  }
  const data = parsed.data;
  const choice = data.choices[0];
  if (choice === undefined) {
    return throwSafe('PROTOCOL_INVALID', 'The AI service returned an invalid completion response');
  }
  if (choice.finish_reason === 'length') {
    throwSafe('CONTENT_INVALID', 'The generated content was truncated');
  }
  if (choice.finish_reason === 'content_filter') {
    throwSafe('CONTENT_INVALID', 'The generated content was not accepted');
  }
  if (choice.finish_reason === 'insufficient_system_resource') {
    throwSafe('SERVICE_UNAVAILABLE', 'The AI service had insufficient capacity', {
      retryable: true,
    });
  }
  if (choice.finish_reason === 'tool_calls') {
    throwSafe('PROTOCOL_INVALID', 'The AI service returned an unsupported tool call');
  }
  const content = choice.message.content?.trim() ?? '';
  if (content.length === 0) throwSafe('EMPTY_RESPONSE', 'The AI service returned no content');
  return chatCompletionResultSchema.parse({
    id: data.id,
    model: data.model,
    content,
    finishReason: 'stop',
    ...(data.usage === undefined
      ? {}
      : {
          usage: {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          },
        }),
  });
};

export class DeepSeekClient implements ChatCompletionPort {
  readonly #transport: JsonTransport;
  readonly #onHeaders: () => void;

  constructor(options: { transport?: JsonTransport; onHeaders?: () => void } = {}) {
    this.#transport = options.transport ?? new NativeDeepSeekTransport();
    this.#onHeaders = options.onHeaders ?? (() => undefined);
  }

  async complete(
    inputValue: ChatCompletionInput,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<ChatCompletionResult> {
    const parsedInput = chatCompletionInputSchema.safeParse(inputValue);
    if (!parsedInput.success) {
      throw new AiSafeError(
        makeSafeError('PROTOCOL_INVALID', 'The AI request configuration is invalid'),
      );
    }
    const input = parsedInput.data;
    if (apiKey.trim().length === 0) {
      throw new AiSafeError(makeSafeError('AUTH_REQUIRED', 'An API credential is required'));
    }
    if (
      containsSecretMaterial(
        input.messages.map((message) => message.content),
        [apiKey],
      )
    ) {
      throw new AiSafeError(
        makeSafeError('CONTENT_INVALID', 'The Prompt appears to contain a credential'),
      );
    }
    const response = await this.#transport.post(
      JSON.stringify(buildDeepSeekRequest(input)),
      apiKey,
      signal,
      this.#onHeaders,
    );
    return parseDeepSeekResponse(response);
  }
}
