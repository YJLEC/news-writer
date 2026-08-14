import {
  commentIdSchema,
  compareTimestamps,
  exportRecordIdSchema,
  minuteIdSchema,
  minuteRevisionIdSchema,
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
  projectIdSchema,
  retrievalReportIdSchema,
  runtimeVersionSnapshotSchema,
  safeAppErrorSchema,
  sha256Schema,
  taskIdSchema,
  textArtifactRefSchema,
  timestampSchema,
  versionIdSchema,
  promptIdSchema,
} from '@news-writer/shared';
import { z } from 'zod';

export const projectProfileSchema = z.enum(['official', 'other']);
export const projectStatusSchema = z.enum(['active', 'archived']);
export const taskKindSchema = z.enum(['draftGeneration', 'aiReview', 'commentRevision']);

/**
 * User decisions for the structured fact check. Omitted fields remain in
 * automatic detection mode; `none` explicitly confirms that a fact is not
 * available, while `manual` supplies the value used for prompt preparation.
 */
export const factOverrideItemSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }).strict(),
  z
    .object({
      mode: z.literal('manual'),
      value: z.string().trim().min(1).max(1_000),
    })
    .strict(),
  z.object({ mode: z.literal('none') }).strict(),
]);

export const factOverridesSchema = z
  .object({
    date: factOverrideItemSchema.optional(),
    location: factOverrideItemSchema.optional(),
    organizer: factOverrideItemSchema.optional(),
    time: factOverrideItemSchema.optional(),
  })
  .strict();

export type FactOverrideItem = z.infer<typeof factOverrideItemSchema>;
export type FactOverrides = z.infer<typeof factOverridesSchema>;
export const taskStatusSchema = z.enum([
  'queued',
  'preparing',
  'requesting',
  'processing',
  'supplement',
  'reviewing',
  'saving',
  'succeeded',
  'failed',
  'cancelled',
  'timedOut',
]);

export type ProjectProfile = z.infer<typeof projectProfileSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const writingProfileSnapshotSchema = z
  .object({
    profileId: z.string().trim().min(1).max(128),
    profileVersion: z.string().trim().min(1).max(128),
    writingRulesVersion: z.string().trim().min(1).max(128),
    promptContractVersion: z.string().trim().min(1).max(128),
    documentStyleVersion: z.string().trim().min(1).max(128),
    knowledgeVersion: z.string().trim().min(1).max(128),
    resourceHash: sha256Schema,
    rules: z.array(z.string().trim().min(1).max(2_000)).max(500),
    promptSections: z
      .object({
        initialDraft: z.string().trim().min(1).max(10_000),
        secondReview: z.string().trim().min(1).max(10_000),
        commentRevision: z.string().trim().min(1).max(10_000),
      })
      .strict(),
  })
  .strict();
export type WritingProfileSnapshot = z.infer<typeof writingProfileSnapshotSchema>;

export const generationConfigValuesSchema = z
  .object({
    model: z.string().trim().min(1).max(128),
    reasoningEffort: z.enum(['off', 'low', 'medium', 'high']),
    targetChannel: z.string().trim().min(1).max(120),
    maxWords: z.number().int().min(100).max(10_000).finite(),
    requestTimeoutMs: z.number().int().min(1_000).max(600_000).finite(),
  })
  .strict();

export const generationConfigOverridesSchema = generationConfigValuesSchema
  .partial()
  .strict()
  .refine((value) => Object.values(value).every((entry) => entry !== undefined), {
    message: 'Explicit undefined configuration values are invalid',
  });
export const configSourceSchema = z.enum(['default', 'user', 'project', 'task']);
export const configSourcesSchema = z
  .object({
    model: configSourceSchema,
    reasoningEffort: configSourceSchema,
    targetChannel: configSourceSchema,
    maxWords: configSourceSchema,
    requestTimeoutMs: configSourceSchema,
  })
  .strict();

export const resolvedGenerationConfigSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal('deepseek'),
    profile: projectProfileSchema,
    values: generationConfigValuesSchema,
    sources: configSourcesSchema,
  })
  .strict();

export type GenerationConfigValues = z.infer<typeof generationConfigValuesSchema>;
export type GenerationConfigOverrides = z.infer<typeof generationConfigOverridesSchema>;
export type ResolvedGenerationConfigSnapshot = z.infer<
  typeof resolvedGenerationConfigSnapshotSchema
>;

export const minutesSnapshotSchema = z
  .object({
    minuteId: minuteIdSchema,
    revisionId: minuteRevisionIdSchema,
    createdAt: timestampSchema,
    contentRef: textArtifactRefSchema,
  })
  .strict();

export type MinutesSnapshot = z.infer<typeof minutesSnapshotSchema>;

export const promptMessageSchema = z
  .object({
    role: z.enum(['system', 'user']),
    contentRef: textArtifactRefSchema,
  })
  .strict();

export const promptUpstreamDecisionSchema = z
  .object({
    promptInputFingerprint: sha256Schema,
    currentInputFingerprint: sha256Schema,
    staleResolution: z.enum(['current', 'regenerated', 'continued']),
    previousPromptInputFingerprint: sha256Schema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const promptIsCurrent = value.promptInputFingerprint === value.currentInputFingerprint;
    if (value.staleResolution === 'current') {
      if (!promptIsCurrent || value.previousPromptInputFingerprint !== undefined) {
        context.addIssue({ code: 'custom', message: 'Current Prompt fingerprints are invalid' });
      }
      return;
    }
    if (value.staleResolution === 'continued') {
      if (promptIsCurrent || value.previousPromptInputFingerprint !== undefined) {
        context.addIssue({ code: 'custom', message: 'Continued Prompt fingerprints are invalid' });
      }
      return;
    }
    if (
      !promptIsCurrent ||
      value.previousPromptInputFingerprint === undefined ||
      value.previousPromptInputFingerprint === value.currentInputFingerprint
    ) {
      context.addIssue({ code: 'custom', message: 'Regenerated Prompt fingerprints are invalid' });
    }
  });

export type PromptUpstreamDecision = z.infer<typeof promptUpstreamDecisionSchema>;

export const promptRecordSchema = z
  .object({
    id: promptIdSchema,
    createdAt: timestampSchema,
    purpose: taskKindSchema,
    messages: z.array(promptMessageSchema).min(1).max(16),
    editedByUser: z.boolean(),
    editWarningAcknowledgedAt: timestampSchema.optional(),
    upstream: promptUpstreamDecisionSchema,
  })
  .strict()
  .superRefine((prompt, context) => {
    if (prompt.editedByUser !== (prompt.editWarningAcknowledgedAt !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Edited prompts require exactly one warning acknowledgement',
      });
    }
    if (
      prompt.editWarningAcknowledgedAt !== undefined &&
      compareTimestamps(prompt.editWarningAcknowledgedAt, prompt.createdAt) > 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Prompt warning acknowledgement cannot be later than prompt creation',
      });
    }
  });

export type PromptRecord = z.infer<typeof promptRecordSchema>;

export const queueTaskInputSchema = z
  .object({
    kind: taskKindSchema,
    messages: z.array(promptMessageSchema).min(1).max(16),
    editedByUser: z.boolean(),
    editWarningAcknowledgedAt: timestampSchema.optional(),
    upstream: promptUpstreamDecisionSchema,
    config: z
      .object({
        defaults: generationConfigValuesSchema,
        user: generationConfigOverridesSchema.optional(),
        task: generationConfigOverridesSchema.optional(),
      })
      .strict(),
    profileSnapshot: writingProfileSnapshotSchema.optional(),
    factOverrides: factOverridesSchema.optional(),
    supplementalFacts: z.string().trim().min(1).max(100_000).optional(),
    retrievalReportId: retrievalReportIdSchema.optional(),
    retrievalUnavailable: z.boolean().optional(),
    reviewEnabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.kind === 'draftGeneration' && input.supplementalFacts !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['supplementalFacts'],
        message: 'Draft generation cannot use supplemental facts',
      });
    }
  });

export type QueueTaskInput = z.infer<typeof queueTaskInputSchema>;

export const versionRecordSchema = z
  .object({
    id: versionIdSchema,
    createdAt: timestampSchema,
    parentVersionId: versionIdSchema.nullable(),
    createdBy: taskKindSchema,
    sourcePromptId: promptIdSchema,
    taskId: taskIdSchema,
    taskStatusSnapshot: z.literal('succeeded'),
    configSnapshot: resolvedGenerationConfigSnapshotSchema,
    profileSnapshot: writingProfileSnapshotSchema.optional(),
    factOverrides: factOverridesSchema.optional(),
    contentRef: textArtifactRefSchema.refine((ref) => ref.byteLength > 0, {
      message: 'Successful version content must not be empty',
    }),
  })
  .strict();

export type VersionRecord = z.infer<typeof versionRecordSchema>;

export const textQuoteAnchorSchema = z
  .object({
    kind: z.literal('textQuote'),
    contentSha256: sha256Schema,
    start: nonNegativeIntegerSchema,
    end: positiveIntegerSchema,
    exact: z.string().min(1).max(20_000),
    prefix: z.string().max(256),
    suffix: z.string().max(256),
  })
  .strict()
  .refine((anchor) => anchor.start < anchor.end, {
    message: 'Anchor start must be before end',
  });

export type TextQuoteAnchor = z.infer<typeof textQuoteAnchorSchema>;

export const commentRecordSchema = z
  .object({
    id: commentIdSchema,
    revision: nonNegativeIntegerSchema,
    versionId: versionIdSchema,
    anchor: textQuoteAnchorSchema,
    quotedText: z.string().min(1).max(20_000),
    body: z.string().trim().min(1).max(20_000),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((comment, context) => {
    if (comment.quotedText !== comment.anchor.exact) {
      context.addIssue({ code: 'custom', message: 'Quoted text must equal anchor exact text' });
    }
    if (compareTimestamps(comment.updatedAt, comment.createdAt) < 0) {
      context.addIssue({ code: 'custom', message: 'Comment update cannot precede creation' });
    }
  });

export type CommentRecord = z.infer<typeof commentRecordSchema>;
export const commentSnapshotSchema = commentRecordSchema;
export type CommentSnapshot = CommentRecord;

export const taskHistoryEntrySchema = z
  .object({ status: taskStatusSchema, at: timestampSchema })
  .strict();

const taskBaseFields = {
  id: taskIdSchema,
  sequence: nonNegativeIntegerSchema,
  kind: taskKindSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  parentVersionId: versionIdSchema.nullable(),
  expectedLatestVersionId: versionIdSchema.nullable(),
  baseProjectRevision: nonNegativeIntegerSchema,
  promptId: promptIdSchema,
  configSnapshot: resolvedGenerationConfigSnapshotSchema,
  profileSnapshot: writingProfileSnapshotSchema.optional(),
  minutesSnapshot: minutesSnapshotSchema,
  factOverrides: factOverridesSchema.optional(),
  supplementalFacts: z.string().trim().min(1).max(100_000).optional(),
  reviewEnabled: z.boolean().optional(),
  retrievalReportId: retrievalReportIdSchema.optional(),
  retrievalUnavailable: z.boolean().optional(),
  commentSnapshotAt: timestampSchema.optional(),
  commentSnapshot: z.array(commentSnapshotSchema),
  history: z.array(taskHistoryEntrySchema).min(1),
} as const;

const activeTaskSchema = (
  status: 'queued' | 'preparing' | 'requesting' | 'processing' | 'supplement' | 'reviewing',
) => z.object({ ...taskBaseFields, status: z.literal(status) }).strict();

const transactionUuidSchema = z
  .string()
  .uuid()
  .regex(/^[0-9a-f-]+$/);

const savingTaskSchema = z
  .object({
    ...taskBaseFields,
    status: z.literal('saving'),
    successTransactionId: transactionUuidSchema,
    proposedVersionId: versionIdSchema,
    targetRevision: positiveIntegerSchema,
  })
  .strict();

const succeededTaskSchema = z
  .object({
    ...taskBaseFields,
    status: z.literal('succeeded'),
    completedAt: timestampSchema,
    resultVersionId: versionIdSchema,
    successTransactionId: transactionUuidSchema,
    committedRevision: positiveIntegerSchema,
  })
  .strict();

const failedTaskSchema = (status: 'failed' | 'cancelled' | 'timedOut') =>
  z
    .object({
      ...taskBaseFields,
      status: z.literal(status),
      completedAt: timestampSchema,
      error: safeAppErrorSchema,
    })
    .strict();

const transitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ['preparing', 'failed', 'cancelled'],
  preparing: ['requesting', 'failed', 'cancelled', 'timedOut'],
  requesting: ['processing', 'failed', 'cancelled', 'timedOut'],
  processing: ['saving', 'supplement', 'failed', 'cancelled', 'timedOut'],
  supplement: ['reviewing', 'failed', 'cancelled', 'timedOut'],
  reviewing: ['saving', 'failed', 'cancelled', 'timedOut'],
  saving: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
  timedOut: [],
};

export const canTransitionTask = (from: TaskStatus, to: TaskStatus): boolean =>
  transitions[from].includes(to);

export const taskRecordSchema = z
  .discriminatedUnion('status', [
    activeTaskSchema('queued'),
    activeTaskSchema('preparing'),
    activeTaskSchema('requesting'),
    activeTaskSchema('processing'),
    activeTaskSchema('supplement'),
    activeTaskSchema('reviewing'),
    savingTaskSchema,
    succeededTaskSchema,
    failedTaskSchema('failed'),
    failedTaskSchema('cancelled'),
    failedTaskSchema('timedOut'),
  ])
  .superRefine((task, context) => {
    if (compareTimestamps(task.updatedAt, task.createdAt) < 0) {
      context.addIssue({ code: 'custom', message: 'Task update cannot precede creation' });
    }
    if (
      'completedAt' in task &&
      (task.completedAt !== task.updatedAt ||
        compareTimestamps(task.completedAt, task.createdAt) < 0)
    ) {
      context.addIssue({ code: 'custom', message: 'Task completion timestamp is invalid' });
    }
    if (task.history[0]?.status !== 'queued' || task.history.at(-1)?.status !== task.status) {
      context.addIssue({ code: 'custom', message: 'Task history endpoints are invalid' });
    }
    if (task.history[0]?.at !== task.createdAt || task.history.at(-1)?.at !== task.updatedAt) {
      context.addIssue({ code: 'custom', message: 'Task timestamps must match history endpoints' });
    }
    for (let index = 1; index < task.history.length; index += 1) {
      const previous = task.history[index - 1];
      const current = task.history[index];
      if (
        previous === undefined ||
        current === undefined ||
        compareTimestamps(current.at, previous.at) < 0 ||
        !canTransitionTask(previous.status, current.status)
      ) {
        context.addIssue({ code: 'custom', message: 'Task history transition is invalid' });
        break;
      }
    }
    if (task.kind === 'commentRevision') {
      if (
        task.parentVersionId === null ||
        task.commentSnapshotAt !== task.createdAt ||
        task.commentSnapshot.length === 0
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Comment revision tasks require a parent and non-empty creation snapshot',
        });
      }
    } else if (task.commentSnapshot.length > 0 || task.commentSnapshotAt !== undefined) {
      context.addIssue({ code: 'custom', message: 'Only comment revision tasks carry comments' });
    }
    if (task.kind === 'draftGeneration' && task.supplementalFacts !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['supplementalFacts'],
        message: 'Draft generation cannot use supplemental facts',
      });
    }
    if (task.retrievalReportId !== undefined && task.retrievalUnavailable === true) {
      context.addIssue({ code: 'custom', message: 'A retrieval report cannot be unavailable' });
    }
  });

export type TaskRecord = z.infer<typeof taskRecordSchema>;

export const factHintSchema = z
  .object({
    value: z.string().min(1).max(1_000),
    start: nonNegativeIntegerSchema,
    end: positiveIntegerSchema,
    quote: z.string().min(1).max(1_000),
  })
  .strict()
  .refine((hint) => hint.start < hint.end, { message: 'Fact hint range is invalid' });

export const retrievalReportSchema = z
  .object({
    id: retrievalReportIdSchema,
    createdAt: timestampSchema,
    knowledgeVersion: z.string().trim().min(1).max(128),
    retrievalEngineVersion: z.string().trim().min(1).max(128),
    redactedQueryText: z.string().max(100_000),
    querySha256: sha256Schema,
    factHints: z
      .object({
        dates: z.array(factHintSchema),
        times: z.array(factHintSchema),
        locations: z.array(factHintSchema),
        participants: z.array(factHintSchema),
        missing: z.array(z.enum(['date', 'location', 'organizer'])),
      })
      .strict(),
    hits: z.array(
      z
        .object({
          rank: positiveIntegerSchema,
          documentId: z.string().trim().min(1).max(256),
          title: z.string().trim().min(1).max(500),
          score: z.number().finite().nonnegative(),
          promptExcerpt: z.string().max(20_000),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((report, context) => {
    const documentIds = new Set<string>();
    report.hits.forEach((hit, index) => {
      if (hit.rank !== index + 1 || documentIds.has(hit.documentId)) {
        context.addIssue({ code: 'custom', message: 'Retrieval hit order or identity is invalid' });
      }
      documentIds.add(hit.documentId);
    });
    for (const hints of [
      report.factHints.dates,
      report.factHints.times,
      report.factHints.locations,
      report.factHints.participants,
    ]) {
      for (const hint of hints) {
        if (report.redactedQueryText.slice(hint.start, hint.end) !== hint.quote) {
          context.addIssue({
            code: 'custom',
            message: 'Fact hint quote does not match query text',
          });
        }
      }
    }
  });

export type RetrievalReport = z.infer<typeof retrievalReportSchema>;

const exportBaseFields = {
  id: exportRecordIdSchema,
  versionId: versionIdSchema,
  attemptedAt: timestampSchema,
  completedAt: timestampSchema,
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((value) => !/[\\/:]/.test(value)),
  destinationDisplay: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((value) => !/[\\/:]/.test(value))
    .optional(),
  templateVersion: z.string().trim().min(1).max(128),
  appVersion: z.string().trim().min(1).max(64),
} as const;

export const exportRecordSchema = z
  .discriminatedUnion('status', [
    z
      .object({
        ...exportBaseFields,
        status: z.literal('succeeded'),
        outputSha256: sha256Schema,
        byteLength: positiveIntegerSchema,
      })
      .strict(),
    z
      .object({ ...exportBaseFields, status: z.literal('failed'), error: safeAppErrorSchema })
      .strict(),
  ])
  .refine((record) => compareTimestamps(record.completedAt, record.attemptedAt) >= 0, {
    message: 'Export completion cannot precede attempt',
  });

export type ExportRecord = z.infer<typeof exportRecordSchema>;

export const projectAggregateSchema = z
  .object({
    format: z.literal('news-writer-project'),
    schemaVersion: z.literal(1),
    projectId: projectIdSchema,
    revision: nonNegativeIntegerSchema,
    name: z.string().trim().min(1).max(200),
    profile: projectProfileSchema,
    profileSnapshot: writingProfileSnapshotSchema.optional(),
    status: projectStatusSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    archivedAt: timestampSchema.optional(),
    createdWith: runtimeVersionSnapshotSchema,
    lastWrittenWith: runtimeVersionSnapshotSchema,
    minutes: minutesSnapshotSchema,
    projectConfig: generationConfigOverridesSchema,
    latestVersionId: versionIdSchema.nullable(),
    prompts: z.array(promptRecordSchema),
    tasks: z.array(taskRecordSchema),
    versions: z.array(versionRecordSchema),
    comments: z.array(commentRecordSchema),
    retrievalReports: z.array(retrievalReportSchema),
    exportRecords: z.array(exportRecordSchema),
  })
  .strict()
  .superRefine((project, context) => {
    if ((project.status === 'archived') !== (project.archivedAt !== undefined)) {
      context.addIssue({ code: 'custom', message: 'Archived timestamp does not match status' });
    }
    if (compareTimestamps(project.updatedAt, project.createdAt) < 0) {
      context.addIssue({ code: 'custom', message: 'Project update cannot precede creation' });
    }
  });

export type ProjectAggregateV1 = z.infer<typeof projectAggregateSchema>;
