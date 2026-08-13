import { randomUUID } from 'node:crypto';

import type { ChatCompletionInput } from '@news-writer/ai';
import { taskIdSchema } from '@news-writer/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  ControlledMockWorkerRunner,
  controlledPlanSchema,
  parseControlledPlan,
} from './e2e-controlled-runner.js';

const input: ChatCompletionInput = {
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'synthetic prompt' }],
  reasoningEffort: 'off',
  maxWords: 500,
};

describe('ControlledMockWorkerRunner', () => {
  it('strictly bounds startup plans', () => {
    const valid = {
      schema: 'news-writer-controlled-ai-plan-v1',
      steps: [{ type: 'hang', requestingAfterMs: 0, processingAfterMs: 0, settleAfterMs: 0 }],
    };
    expect(parseControlledPlan(JSON.stringify(valid))).toEqual(valid);
    expect(() => parseControlledPlan(JSON.stringify({ ...valid, injected: true }))).toThrow(
      'Invalid controlled AI startup plan',
    );
    expect(() => parseControlledPlan('{')).toThrow('Invalid controlled AI startup plan');
    expect(
      controlledPlanSchema.safeParse({
        ...valid,
        steps: Array.from({ length: 17 }, () => valid.steps[0]),
      }).success,
    ).toBe(false);
  });

  it('atomically consumes successful steps and never records the credential', async () => {
    vi.useFakeTimers();
    try {
      const runner = new ControlledMockWorkerRunner(
        controlledPlanSchema.parse({
          schema: 'news-writer-controlled-ai-plan-v1',
          steps: [
            {
              type: 'success',
              content: '合成新闻稿正文。',
              completionId: 'completion-1',
              requestingAfterMs: 1,
              processingAfterMs: 1,
              settleAfterMs: 1,
            },
          ],
        }),
      );
      const statuses: string[] = [];
      const run = runner.run(
        taskIdSchema.parse(randomUUID()),
        input,
        'credential-that-must-not-be-retained',
        (status) => statuses.push(status),
      );
      await vi.runAllTimersAsync();
      await expect(run.result).resolves.toMatchObject({
        id: 'completion-1',
        content: '合成新闻稿正文。',
      });
      expect(statuses).toEqual(['requesting', 'processing']);
      expect(() =>
        runner.run(taskIdSchema.parse(randomUUID()), input, 'another-key', () => undefined),
      ).toThrowError('The controlled AI plan was exhausted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a hanging run on cancel and shutdown', async () => {
    vi.useFakeTimers();
    try {
      const runner = new ControlledMockWorkerRunner(
        controlledPlanSchema.parse({
          schema: 'news-writer-controlled-ai-plan-v1',
          steps: [
            {
              type: 'hang',
              requestingAfterMs: 10,
              processingAfterMs: 10,
              settleAfterMs: 0,
            },
          ],
        }),
      );
      const status = vi.fn();
      const run = runner.run(taskIdSchema.parse(randomUUID()), input, 'key', status);
      run.cancel();
      await run.shutdown(1);
      await vi.runAllTimersAsync();
      expect(status).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
