import { describe, expect, it } from 'vitest';

import type { ChatCompletionInput } from './contracts';
import {
  buildDeepSeekRequest,
  DeepSeekClient,
  parseDeepSeekResponse,
  toMaxTokens,
} from './deepseek';
import { AiSafeError } from './errors';
import type { JsonTransport, TransportResponse } from './transport';

const input = (reasoningEffort: ChatCompletionInput['reasoningEffort']): ChatCompletionInput => ({
  model: 'deepseek-v4-pro',
  messages: [
    { role: 'system', content: 'Follow the approved writing rules.' },
    { role: 'user', content: 'Write the synthetic event report.' },
  ],
  reasoningEffort,
  maxWords: 900,
});

const response = (overrides: Record<string, unknown> = {}): TransportResponse => ({
  status: 200,
  contentType: 'application/json; charset=utf-8',
  retryAfter: null,
  body: new TextEncoder().encode(
    JSON.stringify({
      id: 'completion-1',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-v4-pro',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '  Synthetic report.  ',
            reasoning_content: 'hidden',
          },
          finish_reason: 'stop',
          ignored: 'discarded',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      ignored: 'discarded',
      ...overrides,
    }),
  ),
});

const expectCode = (operation: () => unknown, code: string): void => {
  try {
    operation();
    throw new Error('Expected operation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(AiSafeError);
    expect((error as AiSafeError).safe.code).toBe(code);
    expect(JSON.stringify((error as AiSafeError).safe)).not.toMatch(
      /hidden|Synthetic|Authorization|stack/i,
    );
  }
};

describe('DeepSeek wire adapter', () => {
  it('keeps the production endpoint fixed', async () => {
    const { DEEPSEEK_ENDPOINT } = await import('./transport');
    expect(DEEPSEEK_ENDPOINT).toBe('https://api.deepseek.com/chat/completions');
  });

  it.each([
    ['off', { type: 'disabled' }, undefined],
    ['low', { type: 'enabled' }, 'low'],
    ['medium', { type: 'enabled' }, 'medium'],
    ['high', { type: 'enabled' }, 'high'],
  ] as const)(
    'builds the exact non-streaming request for %s reasoning',
    (effort, thinking, wireEffort) => {
      const body = buildDeepSeekRequest(input(effort));
      expect(body).toEqual({
        model: 'deepseek-v4-pro',
        messages: input(effort).messages,
        stream: false,
        thinking,
        ...(wireEffort === undefined ? {} : { reasoning_effort: wireEffort }),
        max_tokens: 32_768,
      });
      expect(Object.keys(body).toSorted()).toEqual(
        [
          'model',
          'messages',
          'stream',
          'thinking',
          'max_tokens',
          ...(wireEffort ? ['reasoning_effort'] : []),
        ].toSorted(),
      );
    },
  );

  it('uses the full provider output budget independent of the prose target', () => {
    expect(toMaxTokens(100)).toBe(32_768);
    expect(toMaxTokens(10_000)).toBe(32_768);
  });

  it('normalizes the only choice and discards reasoning and unknown fields', () => {
    expect(parseDeepSeekResponse(response())).toEqual({
      id: 'completion-1',
      model: 'deepseek-v4-pro',
      content: 'Synthetic report.',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
  });

  it('rejects wrong content type and truncated JSON', () => {
    expectCode(
      () => parseDeepSeekResponse({ ...response(), contentType: 'text/plain' }),
      'PROTOCOL_INVALID',
    );
    expectCode(
      () =>
        parseDeepSeekResponse({
          ...response(),
          body: new TextEncoder().encode('{"id":"truncated"'),
        }),
      'PROTOCOL_INVALID',
    );
  });

  it.each([
    ['length', 'CONTENT_INVALID'],
    ['content_filter', 'CONTENT_INVALID'],
    ['insufficient_system_resource', 'SERVICE_UNAVAILABLE'],
    ['tool_calls', 'PROTOCOL_INVALID'],
  ])('maps finish reason %s', (finishReason, code) => {
    expectCode(
      () =>
        parseDeepSeekResponse(
          response({
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'partial' },
                finish_reason: finishReason,
              },
            ],
          }),
        ),
      code,
    );
  });

  it.each([
    [{ choices: [] }, 'PROTOCOL_INVALID'],
    [
      {
        choices: [
          { index: 1, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' },
        ],
      },
      'PROTOCOL_INVALID',
    ],
    [
      {
        choices: [
          { index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' },
        ],
      },
      'EMPTY_RESPONSE',
    ],
    [
      {
        choices: [
          { index: 0, message: { role: 'assistant', content: '   ' }, finish_reason: 'stop' },
        ],
      },
      'EMPTY_RESPONSE',
    ],
    [
      {
        choices: [
          { index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'future' },
        ],
      },
      'PROTOCOL_INVALID',
    ],
    [{ usage: { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 } }, 'PROTOCOL_INVALID'],
  ])('rejects malformed completion %#', (override, code) => {
    expectCode(() => parseDeepSeekResponse(response(override)), code);
  });

  it.each([
    [401, 'AUTH_REJECTED', false],
    [402, 'INSUFFICIENT_BALANCE', false],
    [429, 'RATE_LIMITED', true],
    [500, 'SERVICE_UNAVAILABLE', true],
    [503, 'SERVICE_UNAVAILABLE', true],
    [400, 'PROTOCOL_INVALID', false],
    [422, 'PROTOCOL_INVALID', false],
  ])('maps HTTP %i without exposing the body', (status, code, retryable) => {
    try {
      parseDeepSeekResponse({
        ...response(),
        status,
        retryAfter: '999999',
        body: new TextEncoder().encode('provider secret'),
      });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AiSafeError);
      const safe = (error as AiSafeError).safe;
      expect(safe).toMatchObject({ code, retryable, httpStatus: status });
      if (status === 429) expect(safe.retryAfterSeconds).toBe(86_400);
      expect(JSON.stringify(safe)).not.toContain('provider secret');
    }
  });

  it('blocks missing or embedded credentials before transport and never retries', async () => {
    let calls = 0;
    const transport: JsonTransport = {
      post: () => {
        calls += 1;
        return Promise.reject(
          new AiSafeError({
            code: 'NETWORK_UNAVAILABLE',
            occurredAt: '2026-08-09T01:00:00.000Z' as never,
            safeMessage: 'offline',
            retryable: true,
          }),
        );
      },
    };
    const client = new DeepSeekClient({ transport });
    await expect(
      client.complete(input('off'), '', new AbortController().signal),
    ).rejects.toMatchObject({ safe: { code: 'AUTH_REQUIRED' } });
    await expect(
      client.complete(
        { ...input('off'), messages: [{ role: 'user', content: 'contains fake-secret-value' }] },
        'fake-secret-value',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ safe: { code: 'CONTENT_INVALID' } });
    await expect(
      client.complete(input('off'), 'safe-test-credential', new AbortController().signal),
    ).rejects.toMatchObject({ safe: { code: 'NETWORK_UNAVAILABLE' } });
    expect(calls).toBe(1);
  });

  it('rejects a historical model before transport', async () => {
    let calls = 0;
    const client = new DeepSeekClient({
      transport: {
        post: () => {
          calls += 1;
          return Promise.resolve(response());
        },
      },
    });
    await expect(
      client.complete(
        { ...input('off'), model: 'deepseek-chat' } as unknown as ChatCompletionInput,
        'test-credential',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ safe: { code: 'PROTOCOL_INVALID' } });
    expect(calls).toBe(0);
  });
});
