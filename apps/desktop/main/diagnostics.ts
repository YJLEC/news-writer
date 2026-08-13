import { randomUUID } from 'node:crypto';

import { safeAppErrorCodeSchema, taskIdSchema, timestampSchema } from '@news-writer/shared';
import { z } from 'zod';

export const diagnosticEventSchema = z
  .object({
    name: z.enum(['renderer-crashed', 'shutdown-watchdog', 'ipc-rejected', 'task-status']),
    occurredAt: timestampSchema,
    diagnosticId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    sessionId: z.string().uuid().optional(),
    taskId: taskIdSchema.optional(),
    status: z.string().max(32).optional(),
    errorCode: safeAppErrorCodeSchema.optional(),
    httpClass: z.enum(['4xx', '5xx']).optional(),
    durationBucket: z.enum(['lt1s', '1to10s', '10to60s', 'gte60s']).optional(),
  })
  .strict();

export type DiagnosticEvent = z.infer<typeof diagnosticEventSchema>;

export class SafeDiagnostics {
  readonly #events: DiagnosticEvent[] = [];

  record(input: Omit<DiagnosticEvent, 'occurredAt' | 'diagnosticId'>): string {
    const diagnosticId = randomUUID();
    this.#events.push(
      diagnosticEventSchema.parse({
        ...input,
        diagnosticId,
        occurredAt: timestampSchema.parse(new Date().toISOString()),
      }),
    );
    if (this.#events.length > 200) this.#events.shift();
    return diagnosticId;
  }

  snapshot(): readonly DiagnosticEvent[] {
    return structuredClone(this.#events);
  }
}
