import { describe, expect, it } from 'vitest';

import { chatCompletionInputSchema, workerCommandSchema, workerEventSchema } from './contracts';

describe('AI boundary schemas', () => {
  it('rejects unsupported models, roles, extra fields and oversized messages', () => {
    const base = {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'prompt' }],
      reasoningEffort: 'medium',
      maxWords: 900,
    };
    expect(chatCompletionInputSchema.safeParse(base).success).toBe(true);
    expect(chatCompletionInputSchema.safeParse({ ...base, model: 'deepseek-chat' }).success).toBe(
      false,
    );
    expect(
      chatCompletionInputSchema.safeParse({ ...base, endpoint: 'http://localhost' }).success,
    ).toBe(false);
    expect(
      chatCompletionInputSchema.safeParse({
        ...base,
        messages: [{ role: 'assistant', content: 'x' }],
      }).success,
    ).toBe(false);
    expect(
      chatCompletionInputSchema.safeParse({
        ...base,
        messages: [{ role: 'user', content: 'x'.repeat(1_000_001) }],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown worker commands and forged terminal events', () => {
    const taskId = '00000000-0000-4000-8000-000000000001';
    expect(workerCommandSchema.safeParse({ type: 'shutdown', taskId }).success).toBe(false);
    expect(
      workerEventSchema.safeParse({ type: 'succeeded', taskId, content: 'forged' }).success,
    ).toBe(false);
    expect(workerEventSchema.safeParse({ type: 'requesting', taskId, extra: true }).success).toBe(
      false,
    );
  });
});
