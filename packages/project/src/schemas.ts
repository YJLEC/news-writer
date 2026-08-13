import {
  commentRecordSchema,
  exportRecordSchema,
  generationConfigOverridesSchema,
  minutesSnapshotSchema,
  projectProfileSchema,
  projectStatusSchema,
  writingProfileSnapshotSchema,
  promptRecordSchema,
  retrievalReportSchema,
  taskRecordSchema,
  versionRecordSchema,
} from '@news-writer/domain';
import {
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
  projectIdSchema,
  projectRelativePathSchema,
  runtimeVersionSnapshotSchema,
  sha256Schema,
  timestampSchema,
} from '@news-writer/shared';
import { z } from 'zod';

const lowerUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const commitIdSchema = z.string().regex(lowerUuidPattern).brand('CommitId');
export const transactionIdSchema = z.string().regex(lowerUuidPattern).brand('TransactionId');
export const instanceIdSchema = z.string().regex(lowerUuidPattern).brand('InstanceId');

export type CommitId = z.infer<typeof commitIdSchema>;
export type TransactionId = z.infer<typeof transactionIdSchema>;
export type InstanceId = z.infer<typeof instanceIdSchema>;

export const storedObjectKindSchema = z.enum([
  'minutes',
  'versionContent',
  'promptContent',
  'prompt',
  'task',
  'version',
  'comment',
  'retrievalReport',
  'exportRecord',
  'snapshot',
]);

export const storedObjectRefSchema = z
  .object({
    relativePath: projectRelativePathSchema,
    sha256: sha256Schema,
    byteLength: nonNegativeIntegerSchema,
    kind: storedObjectKindSchema,
    entityId: z.string().regex(lowerUuidPattern),
    recordVersion: positiveIntegerSchema,
  })
  .strict();

export type StoredObjectRef = z.infer<typeof storedObjectRefSchema>;

export const storageEnvelopeProbeSchema = z
  .object({
    format: z.string(),
    storageVersion: positiveIntegerSchema,
    schemaVersion: positiveIntegerSchema,
  })
  .passthrough();

export const projectMetadataV1Schema = z
  .object({
    name: z.string().trim().min(1).max(200),
    profile: projectProfileSchema,
    profileSnapshot: writingProfileSnapshotSchema.optional(),
    status: projectStatusSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    archivedAt: timestampSchema.optional(),
    createdWith: runtimeVersionSnapshotSchema,
    lastWrittenWith: runtimeVersionSnapshotSchema,
    projectConfig: generationConfigOverridesSchema,
  })
  .strict();

export const projectStateIndexV1Schema = z
  .object({
    project: projectMetadataV1Schema,
    currentMinutes: storedObjectRefSchema,
    latestVersionId: z.string().regex(lowerUuidPattern).brand('VersionId').nullable(),
    prompts: z.array(storedObjectRefSchema),
    tasks: z.array(storedObjectRefSchema),
    versions: z.array(storedObjectRefSchema),
    comments: z.array(storedObjectRefSchema),
    retrievalReports: z.array(storedObjectRefSchema),
    exportRecords: z.array(storedObjectRefSchema),
  })
  .strict();

export type ProjectStateIndexV1 = z.infer<typeof projectStateIndexV1Schema>;

const snapshotRefSchema = storedObjectRefSchema.refine((ref) => ref.kind === 'snapshot', {
  message: 'Expected snapshot reference',
});

export const projectHeadV1Schema = z
  .object({
    format: z.literal('news-writer-project'),
    storageVersion: z.literal(1),
    schemaVersion: z.literal(1),
    projectId: projectIdSchema,
    revision: nonNegativeIntegerSchema,
    headCommitId: commitIdSchema,
    headCommitHash: sha256Schema,
    snapshot: snapshotRefSchema,
    state: projectStateIndexV1Schema,
  })
  .strict();

export type ProjectHeadV1 = z.infer<typeof projectHeadV1Schema>;

export const projectStateSnapshotV1Schema = z
  .object({
    format: z.literal('news-writer-state-snapshot'),
    storageVersion: z.literal(1),
    schemaVersion: z.literal(1),
    projectId: projectIdSchema,
    revision: nonNegativeIntegerSchema,
    commitId: commitIdSchema,
    state: projectStateIndexV1Schema,
  })
  .strict();

export type ProjectStateSnapshotV1 = z.infer<typeof projectStateSnapshotV1Schema>;

export const recordKindSchema = z.enum([
  'minutes',
  'prompt',
  'task',
  'version',
  'comment',
  'retrievalReport',
  'exportRecord',
]);

const recordPayloadSchemas = {
  minutes: minutesSnapshotSchema,
  prompt: promptRecordSchema,
  task: taskRecordSchema,
  version: versionRecordSchema,
  comment: commentRecordSchema,
  retrievalReport: retrievalReportSchema,
  exportRecord: exportRecordSchema,
} as const;

export const diskRecordV1Schema = z
  .object({
    format: z.literal('news-writer-record'),
    storageVersion: z.literal(1),
    schemaVersion: z.literal(1),
    kind: recordKindSchema,
    entityId: z.string().regex(lowerUuidPattern),
    payload: z.unknown(),
  })
  .strict()
  .superRefine((record, context) => {
    const result = recordPayloadSchemas[record.kind].safeParse(record.payload);
    if (!result.success) {
      context.addIssue({ code: 'custom', message: `Invalid ${record.kind} record payload` });
      return;
    }
    const payload = result.data as { id?: string; minuteId?: string };
    const payloadId = payload.id ?? payload.minuteId;
    if (payloadId !== record.entityId) {
      context.addIssue({ code: 'custom', message: 'Record entity ID mismatch' });
    }
  });

export type DiskRecordV1 = z.infer<typeof diskRecordV1Schema>;

export const commitOperationSchema = z.enum([
  'genesis',
  'update',
  'completeTaskWithVersion',
  'migration',
]);

const manifestBaseFields = {
  storageVersion: z.literal(1),
  schemaVersion: z.literal(1),
  projectId: projectIdSchema,
  commitId: commitIdSchema,
  parentCommitId: commitIdSchema.nullable(),
  parentCommitHash: sha256Schema.nullable(),
  transactionId: transactionIdSchema,
  operation: commitOperationSchema,
  baseRevision: nonNegativeIntegerSchema.nullable(),
  revision: nonNegativeIntegerSchema,
  createdAt: timestampSchema,
  snapshot: snapshotRefSchema,
} as const;

export const commitWriteSchema = z
  .object({
    relativePath: projectRelativePathSchema,
    sha256: sha256Schema,
    byteLength: nonNegativeIntegerSchema,
    kind: storedObjectKindSchema.exclude(['snapshot']),
    entityId: z.string().regex(lowerUuidPattern),
    recordVersion: positiveIntegerSchema,
  })
  .strict();

export const completeTaskCommitDetailsSchema = z
  .object({
    operation: z.literal('completeTaskWithVersion'),
    successTransactionId: transactionIdSchema,
    taskId: z.string().regex(lowerUuidPattern).brand('TaskId'),
    fromTaskSequence: nonNegativeIntegerSchema,
    toTaskSequence: positiveIntegerSchema,
    versionId: z.string().regex(lowerUuidPattern).brand('VersionId'),
    baseRevision: nonNegativeIntegerSchema,
    revision: positiveIntegerSchema,
  })
  .strict()
  .refine((details) => details.toTaskSequence === details.fromTaskSequence + 1, {
    message: 'Completed task sequence must advance exactly once',
  });

const migrationCommitDetailsSchema = z
  .object({
    operation: z.literal('migration'),
    fromSchemaVersion: positiveIntegerSchema,
    toSchemaVersion: positiveIntegerSchema,
    appVersion: z.string().trim().min(1).max(64),
  })
  .strict();

const simpleCommitDetailsSchema = z.object({ operation: z.enum(['genesis', 'update']) }).strict();

export const commitDetailsSchema = z.discriminatedUnion('operation', [
  simpleCommitDetailsSchema,
  completeTaskCommitDetailsSchema,
  migrationCommitDetailsSchema,
]);

interface ManifestLike {
  operation: z.infer<typeof commitOperationSchema>;
  baseRevision: number | null;
  revision: number;
  parentCommitId: string | null;
  parentCommitHash: string | null;
  transactionId: string;
  commitId: string;
  snapshot: StoredObjectRef;
  writes: ReadonlyArray<{ relativePath: string }>;
  details: z.infer<typeof commitDetailsSchema>;
}

const validateManifest = (manifest: ManifestLike, context: z.RefinementCtx): void => {
  const genesis = manifest.operation === 'genesis';
  if (
    genesis !==
    (manifest.baseRevision === null &&
      manifest.parentCommitId === null &&
      manifest.parentCommitHash === null &&
      manifest.revision === 0)
  ) {
    context.addIssue({ code: 'custom', message: 'Genesis chain fields are invalid' });
  }
  if (
    !genesis &&
    (manifest.baseRevision === null ||
      manifest.parentCommitId === null ||
      manifest.parentCommitHash === null ||
      manifest.revision !== manifest.baseRevision + 1)
  ) {
    context.addIssue({ code: 'custom', message: 'Commit revision must advance exactly once' });
  }
  if (manifest.details.operation !== manifest.operation) {
    context.addIssue({ code: 'custom', message: 'Commit details operation mismatch' });
  }
  if (manifest.snapshot.entityId !== manifest.commitId) {
    context.addIssue({ code: 'custom', message: 'Snapshot identity does not match commit' });
  }
  const expectedSnapshotPath = `.news-writer/snapshots/${manifest.revision}-${manifest.commitId}.json`;
  if (manifest.snapshot.relativePath !== expectedSnapshotPath) {
    context.addIssue({ code: 'custom', message: 'Snapshot path does not match commit' });
  }
  const writePaths = new Set<string>();
  for (const write of manifest.writes) {
    if (writePaths.has(write.relativePath)) {
      context.addIssue({ code: 'custom', message: 'Commit writes contain duplicate paths' });
    }
    writePaths.add(write.relativePath);
  }
  if (
    manifest.operation === 'completeTaskWithVersion' &&
    manifest.details.operation === 'completeTaskWithVersion'
  ) {
    if (manifest.details.successTransactionId !== manifest.transactionId) {
      context.addIssue({ code: 'custom', message: 'Success transaction ID mismatch' });
    }
    if (
      manifest.details.baseRevision !== manifest.baseRevision ||
      manifest.details.revision !== manifest.revision
    ) {
      context.addIssue({ code: 'custom', message: 'Completed task revision details mismatch' });
    }
  }
  if (
    manifest.operation === 'migration' &&
    manifest.details.operation === 'migration' &&
    manifest.details.toSchemaVersion !== manifest.details.fromSchemaVersion + 1
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Migration must advance exactly one schema version',
    });
  }
};

export const commitManifestV1Schema = z
  .object({
    format: z.literal('news-writer-commit'),
    ...manifestBaseFields,
    writes: z.array(commitWriteSchema),
    details: commitDetailsSchema,
  })
  .strict()
  .superRefine(validateManifest);

export type CommitManifestV1 = z.infer<typeof commitManifestV1Schema>;

export const prepareWriteSchema = commitWriteSchema.extend({
  stagingPath: projectRelativePathSchema,
});

export const prepareManifestV1Schema = z
  .object({
    format: z.literal('news-writer-prepare'),
    ...manifestBaseFields,
    writes: z.array(prepareWriteSchema),
    details: commitDetailsSchema,
  })
  .strict()
  .superRefine(validateManifest);

export type PrepareManifestV1 = z.infer<typeof prepareManifestV1Schema>;

export const lockOwnerV1Schema = z
  .object({
    format: z.literal('news-writer-lock-owner'),
    storageVersion: z.literal(1),
    instanceId: instanceIdSchema,
    pid: positiveIntegerSchema,
    processStartedAt: timestampSchema,
    appVersion: z.string().trim().min(1).max(64),
    heartbeatAt: timestampSchema,
  })
  .strict();

export type LockOwnerV1 = z.infer<typeof lockOwnerV1Schema>;
