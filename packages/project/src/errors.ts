import { type Timestamp, safeAppErrorSchema, timestampSchema } from '@news-writer/shared';

import { type InstanceId, type TransactionId } from './schemas.js';

type ProjectErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_ALREADY_EXISTS'
  | 'PROJECT_NOT_WRITABLE'
  | 'PROJECT_FILESYSTEM_UNSUPPORTED'
  | 'PROJECT_LOCKED'
  | 'PROJECT_LOCK_RECOVERY_REQUIRED'
  | 'PROJECT_LOCK_COMPROMISED'
  | 'PROJECT_CONFLICT'
  | 'PROJECT_PATH_INVALID'
  | 'PROJECT_PATH_ESCAPE'
  | 'PROJECT_SCHEMA_INVALID'
  | 'PROJECT_SCHEMA_TOO_NEW'
  | 'PROJECT_MIGRATION_FAILED'
  | 'PROJECT_HASH_MISMATCH'
  | 'PROJECT_RECOVERY_REQUIRED'
  | 'PROJECT_RECOVERY_AMBIGUOUS'
  | 'PROJECT_DISK_FULL'
  | 'PROJECT_ATOMIC_REPLACE_FAILED'
  | 'PROJECT_IO_ERROR';

export class ProjectError extends Error {
  readonly code: ProjectErrorCode;
  readonly retryable: boolean;
  readonly transactionId: TransactionId | undefined;
  readonly causeCode: string | undefined;
  readonly suggestedAction: string | undefined;
  readonly observedLockInstanceId: InstanceId | undefined;

  constructor(
    code: ProjectErrorCode,
    safeMessage: string,
    options: {
      retryable?: boolean;
      transactionId?: TransactionId;
      causeCode?: string;
      suggestedAction?: string;
      observedLockInstanceId?: InstanceId;
    } = {},
  ) {
    super(safeMessage);
    this.name = 'ProjectError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.transactionId = options.transactionId;
    this.causeCode = options.causeCode;
    this.suggestedAction = options.suggestedAction;
    this.observedLockInstanceId = options.observedLockInstanceId;
  }

  static schemaInvalid(message = 'Project data is invalid'): ProjectError {
    return new ProjectError('PROJECT_SCHEMA_INVALID', message);
  }

  static hashMismatch(message = 'Project data integrity check failed'): ProjectError {
    return new ProjectError('PROJECT_HASH_MISMATCH', message);
  }

  toSafeError(occurredAt: Timestamp = timestampSchema.parse(new Date().toISOString())) {
    return safeAppErrorSchema.parse({
      code: this.code,
      occurredAt,
      safeMessage: this.message,
      retryable: this.retryable,
      ...(this.transactionId === undefined ? {} : { transactionId: this.transactionId }),
      ...(this.causeCode === undefined ? {} : { causeCode: this.causeCode }),
      ...(this.suggestedAction === undefined ? {} : { suggestedAction: this.suggestedAction }),
    });
  }
}

const systemCauseCodes = new Set([
  'EACCES',
  'EBUSY',
  'EDQUOT',
  'EEXIST',
  'ENOENT',
  'ENOSPC',
  'EPERM',
  'EROFS',
  'EXDEV',
]);

const getSystemCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && systemCauseCodes.has(code) ? code : undefined;
};

export const mapFileSystemError = (error: unknown): ProjectError => {
  if (error instanceof ProjectError) return error;
  const causeCode = getSystemCode(error);
  if (causeCode === 'ENOENT')
    return new ProjectError('PROJECT_NOT_FOUND', 'Project data was not found', { causeCode });
  if (causeCode === 'ENOSPC' || causeCode === 'EDQUOT') {
    return new ProjectError(
      'PROJECT_DISK_FULL',
      'The project could not be saved because storage is full',
      {
        causeCode,
        retryable: true,
      },
    );
  }
  if (causeCode === 'EROFS' || causeCode === 'EACCES' || causeCode === 'EPERM') {
    return new ProjectError('PROJECT_NOT_WRITABLE', 'The project directory is not writable', {
      causeCode,
    });
  }
  if (causeCode === 'EXDEV') {
    return new ProjectError(
      'PROJECT_FILESYSTEM_UNSUPPORTED',
      'The project directory does not support required atomic operations',
      {
        causeCode,
      },
    );
  }
  return new ProjectError('PROJECT_IO_ERROR', 'A project file operation failed', {
    ...(causeCode === undefined ? {} : { causeCode }),
  });
};
