import { z } from 'zod';

export * from './secrets.js';

const lowerUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const brandedUuid = <T extends string>(brand: T) =>
  z.string().regex(lowerUuidPattern, `${brand} must be a lowercase UUID`).brand(brand);

export const projectIdSchema = brandedUuid('ProjectId');
export const versionIdSchema = brandedUuid('VersionId');
export const commentIdSchema = brandedUuid('CommentId');
export const promptIdSchema = brandedUuid('PromptId');
export const taskIdSchema = brandedUuid('TaskId');
export const retrievalReportIdSchema = brandedUuid('RetrievalReportId');
export const exportRecordIdSchema = brandedUuid('ExportRecordId');
export const minuteIdSchema = brandedUuid('MinuteId');
export const minuteRevisionIdSchema = brandedUuid('MinuteRevisionId');

export type ProjectId = z.infer<typeof projectIdSchema>;
export type VersionId = z.infer<typeof versionIdSchema>;
export type CommentId = z.infer<typeof commentIdSchema>;
export type PromptId = z.infer<typeof promptIdSchema>;
export type TaskId = z.infer<typeof taskIdSchema>;
export type RetrievalReportId = z.infer<typeof retrievalReportIdSchema>;
export type ExportRecordId = z.infer<typeof exportRecordIdSchema>;
export type MinuteId = z.infer<typeof minuteIdSchema>;
export type MinuteRevisionId = z.infer<typeof minuteRevisionIdSchema>;

export const timestampSchema = z
  .string()
  .regex(
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3,9}Z$/,
    'Timestamp must be a UTC RFC 3339 value with fractional seconds',
  )
  .refine((value) => {
    const date = new Date(value);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
  }, 'Timestamp contains an invalid calendar date')
  .brand('Timestamp');

export type Timestamp = z.infer<typeof timestampSchema>;

const normalizedTimestamp = (value: Timestamp): string => {
  const [whole, fractionWithSuffix] = value.split('.');
  const fraction = fractionWithSuffix?.slice(0, -1) ?? '';
  return `${whole}.${fraction.padEnd(9, '0')}Z`;
};

export const compareTimestamps = (left: Timestamp, right: Timestamp): number =>
  normalizedTimestamp(left).localeCompare(normalizedTimestamp(right));

export const sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'SHA-256 must be lowercase hexadecimal')
  .brand('Sha256');

export type Sha256 = z.infer<typeof sha256Schema>;

const windowsDevicePattern = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export const projectRelativePathSchema = z
  .string()
  .superRefine((value, context) => {
    if (
      value.length === 0 ||
      value.includes('\0') ||
      value.includes('\\') ||
      value.includes(':') ||
      value.startsWith('/') ||
      value.endsWith('/')
    ) {
      context.addIssue({ code: 'custom', message: 'Invalid project-relative path' });
      return;
    }

    for (const segment of value.split('/')) {
      if (
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.endsWith('.') ||
        segment.endsWith(' ') ||
        windowsDevicePattern.test(segment)
      ) {
        context.addIssue({ code: 'custom', message: 'Invalid project-relative path segment' });
      }
    }
  })
  .brand('ProjectRelativePath');

export type ProjectRelativePath = z.infer<typeof projectRelativePathSchema>;

export const nonNegativeIntegerSchema = z.number().int().nonnegative().finite();
export const positiveIntegerSchema = z.number().int().positive().finite();

export const runtimeVersionSnapshotSchema = z
  .object({
    appVersion: z.string().trim().min(1).max(64),
    electronVersion: z.string().trim().min(1).max(64),
    chromiumVersion: z.string().trim().min(1).max(64),
  })
  .strict();

export type RuntimeVersionSnapshot = z.infer<typeof runtimeVersionSnapshotSchema>;

export const textArtifactRefSchema = z
  .object({
    relativePath: projectRelativePathSchema,
    sha256: sha256Schema,
    byteLength: nonNegativeIntegerSchema,
    mediaType: z.enum(['text/markdown', 'text/plain']),
    encoding: z.literal('utf-8'),
  })
  .strict();

export type TextArtifactRef = z.infer<typeof textArtifactRefSchema>;

export const imageIdSchema = brandedUuid('ImageId');
export type ImageId = z.infer<typeof imageIdSchema>;

export const imageArtifactRefSchema = z
  .object({
    relativePath: projectRelativePathSchema,
    sha256: sha256Schema,
    byteLength: nonNegativeIntegerSchema,
    mediaType: z.literal('image/jpeg'),
    widthPx: positiveIntegerSchema,
    heightPx: positiveIntegerSchema,
  })
  .strict();

export type ImageArtifactRef = z.infer<typeof imageArtifactRefSchema>;

export const safeAppErrorCodeSchema = z.enum([
  'AUTH_REQUIRED',
  'AUTH_REJECTED',
  'INSUFFICIENT_BALANCE',
  'RATE_LIMITED',
  'NETWORK_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
  'REQUEST_TIMEOUT',
  'REQUEST_CANCELLED',
  'PROTOCOL_INVALID',
  'EMPTY_RESPONSE',
  'CONTENT_INVALID',
  'TASK_INTERRUPTED',
  'PROJECT_NOT_FOUND',
  'PROJECT_ALREADY_EXISTS',
  'PROJECT_NOT_WRITABLE',
  'PROJECT_FILESYSTEM_UNSUPPORTED',
  'PROJECT_LOCKED',
  'PROJECT_LOCK_RECOVERY_REQUIRED',
  'PROJECT_LOCK_COMPROMISED',
  'PROJECT_CONFLICT',
  'PROJECT_PATH_INVALID',
  'PROJECT_PATH_ESCAPE',
  'PROJECT_SCHEMA_INVALID',
  'PROJECT_SCHEMA_TOO_NEW',
  'PROJECT_MIGRATION_FAILED',
  'PROJECT_READ_ONLY',
  'PROJECT_STATE_CONFLICT',
  'PROJECT_HASH_MISMATCH',
  'PROJECT_RECOVERY_REQUIRED',
  'PROJECT_RECOVERY_AMBIGUOUS',
  'PROJECT_DISK_FULL',
  'PROJECT_ATOMIC_REPLACE_FAILED',
  'PROJECT_IO_ERROR',
  'IPC_PROTOCOL_INVALID',
  'IPC_SENDER_REJECTED',
  'AUTH_STORAGE_UNAVAILABLE',
  'AUTH_STORAGE_CORRUPT',
  'CONFIG_STORAGE_UNAVAILABLE',
  'CONFIG_STORAGE_CORRUPT',
  'RESOURCE_UNAVAILABLE',
  'PROFILE_RESOURCE_INVALID',
  'DOCUMENT_CONTENT_INVALID',
  'DOCUMENT_GENERATION_FAILED',
  'EXPORT_PATH_INVALID',
  'EXPORT_NOT_WRITABLE',
  'EXPORT_DISK_FULL',
  'EXPORT_ATOMIC_REPLACE_FAILED',
  'EXPORT_IO_ERROR',
  'UNKNOWN',
]);
export type SafeAppErrorCode = z.infer<typeof safeAppErrorCodeSchema>;

const allowedCauseCodes = new Set([
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

export const safeAppErrorSchema = z
  .object({
    code: safeAppErrorCodeSchema,
    occurredAt: timestampSchema,
    safeMessage: z.string().trim().min(1).max(500),
    retryable: z.boolean(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    retryAfterSeconds: z.number().int().nonnegative().max(86_400).optional(),
    diagnosticId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,128}$/)
      .optional(),
    transactionId: z.string().regex(lowerUuidPattern).optional(),
    suggestedAction: z.string().trim().min(1).max(500).optional(),
    causeCode: z
      .string()
      .refine((value) => allowedCauseCodes.has(value), 'Unsupported cause code')
      .optional(),
  })
  .strict();

export type SafeAppError = z.infer<typeof safeAppErrorSchema>;

export type EntityKind =
  | 'project'
  | 'version'
  | 'comment'
  | 'prompt'
  | 'task'
  | 'retrievalReport'
  | 'exportRecord'
  | 'minute'
  | 'minuteRevision'
  | 'image';

export interface Clock {
  now(): Timestamp;
}

export interface IdGenerator {
  next(kind: EntityKind): string;
}

export const systemClock: Clock = {
  now: () => timestampSchema.parse(new Date().toISOString()),
};

export const sharedPackageName = '@news-writer/shared' as const;
