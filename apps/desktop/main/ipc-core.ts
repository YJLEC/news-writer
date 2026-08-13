import { randomUUID } from 'node:crypto';

import { AiSafeError } from '@news-writer/ai';
import { DomainRuleError } from '@news-writer/domain';
import { ProjectError } from '@news-writer/project';
import { safeAppErrorSchema, timestampSchema, type SafeAppError } from '@news-writer/shared';
import { IPC_PROTOCOL_VERSION } from '@news-writer/shared/ipc';
import type { z } from 'zod';

import { CredentialServiceError } from './credential-service.js';
import { UserConfigServiceError } from './user-config-service.js';

export class SafeMainError extends Error {
  readonly safe: SafeAppError;

  constructor(safe: SafeAppError) {
    super(safe.safeMessage);
    this.name = 'SafeMainError';
    this.safe = safeAppErrorSchema.parse(safe);
  }
}

const safeError = (
  code: SafeAppError['code'],
  safeMessage: string,
  retryable = false,
  diagnosticId?: string,
): SafeAppError =>
  safeAppErrorSchema.parse({
    code,
    occurredAt: timestampSchema.parse(new Date().toISOString()),
    safeMessage,
    retryable,
    ...(diagnosticId === undefined ? {} : { diagnosticId }),
  });

const domainErrorCodes: Readonly<Record<DomainRuleError['code'], SafeAppError['code']>> = {
  ARCHIVED_PROJECT: 'PROJECT_READ_ONLY',
  COMMENT_NOT_EDITABLE: 'PROJECT_STATE_CONFLICT',
  CONTENT_INVALID: 'CONTENT_INVALID',
  ENTITY_NOT_FOUND: 'PROJECT_NOT_FOUND',
  PROFILE_LOCKED: 'PROJECT_STATE_CONFLICT',
  REVISION_CONFLICT: 'PROJECT_CONFLICT',
  STATE_CONFLICT: 'PROJECT_STATE_CONFLICT',
};

export const mapMainError = (error: unknown): SafeAppError => {
  if (
    error instanceof CredentialServiceError ||
    error instanceof UserConfigServiceError ||
    error instanceof AiSafeError ||
    error instanceof SafeMainError
  )
    return error.safe;
  const parsed = safeAppErrorSchema.safeParse(error);
  if (parsed.success) return parsed.data;
  if (error instanceof ProjectError) return error.toSafeError();
  if (error instanceof DomainRuleError) {
    return safeError(domainErrorCodes[error.code], error.message);
  }
  return safeError('UNKNOWN', 'The operation could not be completed', false, randomUUID());
};

const failure = (error: SafeAppError) => ({
  protocolVersion: IPC_PROTOCOL_VERSION,
  ok: false as const,
  error,
});

export interface IpcContract {
  request: z.ZodType;
  result: z.ZodType;
}

export const executeIpcRequest = async (
  contract: IpcContract,
  senderTrusted: boolean,
  handler: (request: unknown, ownerId: number) => Promise<unknown>,
  raw: unknown,
  ownerId: number,
): Promise<unknown> => {
  if (!senderTrusted) {
    return contract.result.parse(
      failure(safeError('IPC_SENDER_REJECTED', 'The desktop request sender was rejected')),
    );
  }
  const request = contract.request.safeParse(raw);
  if (!request.success) {
    return contract.result.parse(
      failure(safeError('IPC_PROTOCOL_INVALID', 'The desktop protocol message is invalid')),
    );
  }
  try {
    const candidate = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      ok: true as const,
      data: await handler(request.data, ownerId),
    };
    const parsed = contract.result.safeParse(candidate);
    return parsed.success
      ? parsed.data
      : contract.result.parse(
          failure(safeError('IPC_PROTOCOL_INVALID', 'The desktop protocol message is invalid')),
        );
  } catch (error) {
    return contract.result.parse(failure(mapMainError(error)));
  }
};
