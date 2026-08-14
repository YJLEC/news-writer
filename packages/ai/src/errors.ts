import {
  safeAppErrorSchema,
  timestampSchema,
  type SafeAppError,
  type SafeAppErrorCode,
} from '@news-writer/shared';

export class AiSafeError extends Error {
  readonly safe: SafeAppError;

  constructor(safe: SafeAppError) {
    super(safe.safeMessage);
    this.name = 'AiSafeError';
    this.safe = safeAppErrorSchema.parse(safe);
  }
}

export interface ErrorOptions {
  retryable?: boolean;
  httpStatus?: number;
  retryAfterSeconds?: number;
  diagnosticId?: string;
}

export const makeSafeError = (
  code: SafeAppErrorCode,
  safeMessage: string,
  options: ErrorOptions = {},
): SafeAppError =>
  safeAppErrorSchema.parse({
    code,
    occurredAt: timestampSchema.parse(new Date().toISOString()),
    safeMessage,
    retryable: options.retryable ?? false,
    ...(options.httpStatus === undefined ? {} : { httpStatus: options.httpStatus }),
    ...(options.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: options.retryAfterSeconds }),
    ...(options.diagnosticId === undefined ? {} : { diagnosticId: options.diagnosticId }),
  });

export const throwSafe = (
  code: SafeAppErrorCode,
  safeMessage: string,
  options?: ErrorOptions,
): never => {
  throw new AiSafeError(makeSafeError(code, safeMessage, options));
};

export const asSafeError = (error: unknown): SafeAppError => {
  if (error instanceof AiSafeError) return error.safe;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return makeSafeError('REQUEST_CANCELLED', 'The request was cancelled', { retryable: true });
  }
  return makeSafeError('PROTOCOL_INVALID', 'The AI worker encountered an unexpected error', {
    retryable: false,
  });
};
