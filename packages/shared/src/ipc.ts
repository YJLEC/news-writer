import { z } from 'zod';

import {
  commentIdSchema,
  minuteIdSchema,
  minuteRevisionIdSchema,
  nonNegativeIntegerSchema,
  promptIdSchema,
  projectIdSchema,
  retrievalReportIdSchema,
  exportRecordIdSchema,
  safeAppErrorSchema,
  sha256Schema,
  taskIdSchema,
  timestampSchema,
  versionIdSchema,
} from './index.js';

export const IPC_PROTOCOL_VERSION = 1 as const;
export const IPC_MAX_STRUCTURED_BYTES = 16 * 1024 * 1024;

const invalidObject = Symbol('invalid IPC object');
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isWithinStructuredByteLimit = (value: Record<string, unknown>): boolean => {
  try {
    const serialized = JSON.stringify(value);
    return (
      serialized !== undefined &&
      new TextEncoder().encode(serialized).byteLength <= IPC_MAX_STRUCTURED_BYTES
    );
  } catch {
    return false;
  }
};

/** Strict objects at the IPC boundary also reject class/custom-prototype instances. */
const ipcObject = <T extends z.ZodRawShape>(shape: T) =>
  z.preprocess(
    (value) => (isPlainObject(value) && isWithinStructuredByteLimit(value) ? value : invalidObject),
    z.object(shape).strict(),
  );

const boundedText = (maximum: number, minimum = 0) => z.string().min(minimum).max(maximum);
const trimmedText = (maximum: number, minimum = 1) => z.string().trim().min(minimum).max(maximum);
const writingProfileSnapshotDtoSchema = ipcObject({
  profileId: trimmedText(128),
  profileVersion: trimmedText(128),
  writingRulesVersion: trimmedText(128),
  promptContractVersion: trimmedText(128),
  documentStyleVersion: trimmedText(128),
  knowledgeVersion: trimmedText(128),
  resourceHash: sha256Schema,
  rules: z.array(trimmedText(2_000)).max(500),
  promptSections: ipcObject({
    initialDraft: trimmedText(10_000),
    secondReview: trimmedText(10_000),
    commentRevision: trimmedText(10_000),
  }),
});
const sessionIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  .brand('SessionId');
const recoveryTokenSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  .brand('RecoveryToken');
const observedLockInstanceIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  .brand('ObservedLockInstanceId');

export { sessionIdSchema };
export type SessionId = z.infer<typeof sessionIdSchema>;

export const projectProfileDtoSchema = z.enum(['official', 'other']);
export const projectStatusDtoSchema = z.enum(['active', 'archived']);
export const taskKindDtoSchema = z.enum(['draftGeneration', 'aiReview', 'commentRevision']);
export const taskStatusDtoSchema = z.enum([
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
export const reasoningEffortDtoSchema = z.enum(['off', 'low', 'medium', 'high']);

export const generationConfigDtoSchema = ipcObject({
  model: trimmedText(128),
  reasoningEffort: reasoningEffortDtoSchema,
  targetChannel: trimmedText(120),
  maxWords: z.number().int().min(100).max(10_000).finite(),
  requestTimeoutMs: z.number().int().min(1_000).max(600_000).finite(),
});

export const generationConfigOverridesDtoSchema = ipcObject({
  model: trimmedText(128).optional(),
  reasoningEffort: reasoningEffortDtoSchema.optional(),
  targetChannel: trimmedText(120).optional(),
  maxWords: z.number().int().min(100).max(10_000).finite().optional(),
  requestTimeoutMs: z.number().int().min(1_000).max(600_000).finite().optional(),
});

export const configSourcesDtoSchema = ipcObject({
  model: z.enum(['default', 'user', 'project', 'task']),
  reasoningEffort: z.enum(['default', 'user', 'project', 'task']),
  targetChannel: z.enum(['default', 'user', 'project', 'task']),
  maxWords: z.enum(['default', 'user', 'project', 'task']),
  requestTimeoutMs: z.enum(['default', 'user', 'project', 'task']),
});

export const resolvedGenerationConfigDtoSchema = ipcObject({
  schemaVersion: z.literal(1),
  provider: z.literal('deepseek'),
  profile: projectProfileDtoSchema,
  values: generationConfigDtoSchema,
  sources: configSourcesDtoSchema,
});

export const runtimeInfoDtoSchema = ipcObject({
  appVersion: trimmedText(64),
  electronVersion: trimmedText(64),
  chromiumVersion: trimmedText(64),
  projectSchemaVersion: z.literal(1),
  knowledgeVersion: trimmedText(128).nullable(),
  profileId: trimmedText(128).nullable().default(null),
  profileVersion: trimmedText(128).nullable().default(null),
  platform: z.literal('win32'),
  arch: z.literal('x64'),
});

export const authStatusDtoSchema = ipcObject({
  provider: z.literal('deepseek'),
  status: z.enum(['notConfigured', 'configured', 'unavailable', 'corrupt']),
  updatedAt: timestampSchema.optional(),
});

export const textQuoteAnchorDtoSchema = ipcObject({
  kind: z.literal('textQuote'),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  start: nonNegativeIntegerSchema,
  end: z.number().int().positive().finite(),
  exact: boundedText(20_000, 1),
  prefix: boundedText(256),
  suffix: boundedText(256),
}).refine((anchor) => anchor.start < anchor.end, 'Anchor start must be before end');

export const minutesViewDtoSchema = ipcObject({
  minuteId: minuteIdSchema,
  revisionId: minuteRevisionIdSchema,
  createdAt: timestampSchema,
  content: boundedText(1_000_000),
});

const factOverrideItemDtoSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }).strict(),
  z.object({ mode: z.literal('manual'), value: trimmedText(1_000) }).strict(),
  z.object({ mode: z.literal('none') }).strict(),
]);
const factOverridesDtoSchema = z
  .object({
    date: factOverrideItemDtoSchema.optional(),
    location: factOverrideItemDtoSchema.optional(),
    organizer: factOverrideItemDtoSchema.optional(),
    time: factOverrideItemDtoSchema.optional(),
  })
  .strict();

export const versionViewDtoSchema = ipcObject({
  id: versionIdSchema,
  createdAt: timestampSchema,
  parentVersionId: versionIdSchema.nullable(),
  createdBy: taskKindDtoSchema,
  taskId: taskIdSchema,
  contentSha256: sha256Schema,
  factOverrides: factOverridesDtoSchema.optional(),
  content: boundedText(8 * 1024 * 1024, 1),
});

export const commentViewDtoSchema = ipcObject({
  id: commentIdSchema,
  revision: nonNegativeIntegerSchema,
  versionId: versionIdSchema,
  anchor: textQuoteAnchorDtoSchema,
  quotedText: boundedText(20_000, 1),
  body: trimmedText(20_000),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const promptMessageDtoSchema = ipcObject({
  role: z.enum(['system', 'user']),
  content: boundedText(1_000_000, 1),
});
export const v1UserPromptMessageDtoSchema = ipcObject({
  role: z.literal('user'),
  content: boundedText(1_000_000, 1),
});

export const promptViewDtoSchema = ipcObject({
  id: promptIdSchema,
  createdAt: timestampSchema,
  purpose: taskKindDtoSchema,
  messages: z.array(promptMessageDtoSchema).min(1).max(16),
  editedByUser: z.boolean(),
  upstream: ipcObject({
    promptInputFingerprint: sha256Schema,
    currentInputFingerprint: sha256Schema,
    staleResolution: z.enum(['current', 'regenerated', 'continued']),
    previousPromptInputFingerprint: sha256Schema.optional(),
  }),
});

export const retrievalTraceDtoSchema = z.union([
  ipcObject({ state: z.enum(['notUsed', 'unavailable']) }),
  ipcObject({
    state: z.enum(['zeroHits', 'used']),
    reportId: retrievalReportIdSchema,
    knowledgeVersion: trimmedText(128),
    hitCount: z.number().int().nonnegative().max(20),
  }),
]);

export const taskHistoryEntryDtoSchema = ipcObject({
  status: taskStatusDtoSchema,
  at: timestampSchema,
});

export const taskViewDtoSchema = ipcObject({
  id: taskIdSchema,
  kind: taskKindDtoSchema,
  status: taskStatusDtoSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  parentVersionId: versionIdSchema.nullable(),
  promptId: promptIdSchema,
  history: z.array(taskHistoryEntryDtoSchema).min(1).max(32),
  configSnapshot: resolvedGenerationConfigDtoSchema,
  factOverrides: factOverridesDtoSchema.optional(),
  minutes: ipcObject({ revisionId: minuteRevisionIdSchema, sha256: sha256Schema }),
  supplement: ipcObject({ present: z.boolean(), sha256: sha256Schema }),
  retrieval: retrievalTraceDtoSchema,
  comments: ipcObject({ count: z.number().int().nonnegative(), sha256: sha256Schema }),
  reviewEnabled: z.boolean().default(false),
  resultVersionId: versionIdSchema.optional(),
  error: safeAppErrorSchema.optional(),
});

export const retrievalHitDtoSchema = ipcObject({
  rank: z.number().int().positive().max(20),
  documentId: trimmedText(256),
  title: trimmedText(500),
  score: z.number().finite().nonnegative(),
  promptExcerpt: boundedText(20_000),
});

export const retrievalSummaryDtoSchema = ipcObject({
  id: retrievalReportIdSchema,
  createdAt: timestampSchema,
  knowledgeVersion: trimmedText(128),
  hitCount: z.number().int().nonnegative().max(20),
});

export const exportRecordViewDtoSchema = z.union([
  ipcObject({
    id: exportRecordIdSchema,
    versionId: versionIdSchema,
    attemptedAt: timestampSchema,
    completedAt: timestampSchema,
    fileName: trimmedText(255),
    status: z.literal('succeeded'),
    templateVersion: trimmedText(128),
    outputSha256: sha256Schema,
    byteLength: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
  }),
  ipcObject({
    id: exportRecordIdSchema,
    versionId: versionIdSchema,
    attemptedAt: timestampSchema,
    completedAt: timestampSchema,
    fileName: trimmedText(255),
    status: z.literal('failed'),
    templateVersion: trimmedText(128),
    error: safeAppErrorSchema,
  }),
]);

export const projectViewDtoSchema = ipcObject({
  sessionId: sessionIdSchema,
  revision: nonNegativeIntegerSchema,
  projectId: projectIdSchema,
  name: trimmedText(200),
  profile: projectProfileDtoSchema,
  status: projectStatusDtoSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  archivedAt: timestampSchema.optional(),
  latestVersionId: versionIdSchema.nullable(),
  projectConfig: generationConfigOverridesDtoSchema,
  minutes: minutesViewDtoSchema,
  versions: z.array(versionViewDtoSchema).max(10_000),
  comments: z.array(commentViewDtoSchema).max(50_000),
  prompts: z.array(promptViewDtoSchema).max(10_000),
  tasks: z.array(taskViewDtoSchema).max(10_000),
  retrievalReports: z.array(retrievalSummaryDtoSchema).max(10_000),
  exportRecords: z.array(exportRecordViewDtoSchema).max(10_000),
});

export const dialogResultSchema = <T extends z.ZodType>(dataSchema: T) =>
  z.union([
    ipcObject({ cancelled: z.literal(true) }),
    ipcObject({ cancelled: z.literal(false), data: dataSchema }),
  ]);

export const projectLockRecoveryDescriptorSchema = ipcObject({
  recoveryToken: recoveryTokenSchema,
  observedInstanceId: observedLockInstanceIdSchema,
});
export const projectOpenDialogResultSchema = z.union([
  ipcObject({ cancelled: z.literal(true) }),
  ipcObject({ cancelled: z.literal(false), data: projectViewDtoSchema }),
  ipcObject({
    cancelled: z.literal(false),
    recoveryRequired: projectLockRecoveryDescriptorSchema,
  }),
]);
export const resumeOwnedProjectResultSchema = z.union([
  ipcObject({ state: z.literal('none') }),
  ipcObject({ state: z.literal('resumed'), project: projectViewDtoSchema }),
]);

export const emptyRequestSchema = ipcObject({});
export const sessionRequestSchema = ipcObject({
  sessionId: sessionIdSchema,
  expectedRevision: nonNegativeIntegerSchema,
});
export const sessionRevisionDtoSchema = sessionRequestSchema;
export const exportDocumentDtoSchema = ipcObject({
  sessionId: sessionIdSchema,
  expectedRevision: nonNegativeIntegerSchema,
  versionId: versionIdSchema,
  title: boundedText(500).optional(),
  signOff: boundedText(500).optional(),
  dateText: boundedText(32).optional(),
});
export const exportDocumentResultDtoSchema = z.union([
  ipcObject({ cancelled: z.literal(true) }),
  ipcObject({
    cancelled: z.literal(false),
    needsInput: z.literal(true),
    requiredFields: z
      .array(z.enum(['title', 'signOff', 'dateText']))
      .min(1)
      .max(3),
  }),
  ipcObject({
    cancelled: z.literal(false),
    needsInput: z.literal(false).optional(),
    project: projectViewDtoSchema,
    record: exportRecordViewDtoSchema,
  }),
]);

export const createProjectDtoSchema = ipcObject({
  name: trimmedText(200),
  profile: projectProfileDtoSchema,
  initialMinutes: boundedText(1_000_000),
  projectConfig: generationConfigOverridesDtoSchema.optional(),
});
export const setDeepSeekApiKeyDtoSchema = ipcObject({
  apiKey: boundedText(4096, 1).refine((value) => value.trim().length > 0, 'API key is empty'),
});
export const clearDeepSeekApiKeyDtoSchema = ipcObject({ confirmed: z.literal(true) });
export const saveMinutesDtoSchema = ipcObject({
  sessionId: sessionIdSchema,
  expectedRevision: nonNegativeIntegerSchema,
  content: boundedText(1_000_000),
});
export const updateProjectConfigDtoSchema = ipcObject({
  sessionId: sessionIdSchema,
  expectedRevision: nonNegativeIntegerSchema,
  config: generationConfigOverridesDtoSchema,
});
export const setArchivedDtoSchema = ipcObject({
  sessionId: sessionIdSchema,
  expectedRevision: nonNegativeIntegerSchema,
  archived: z.boolean(),
});
export const setLatestVersionDtoSchema = ipcObject({
  sessionId: sessionIdSchema,
  expectedRevision: nonNegativeIntegerSchema,
  versionId: versionIdSchema,
});
export const recoverProjectOpenDtoSchema = ipcObject({
  recoveryToken: recoveryTokenSchema,
  confirmed: z.literal(true),
});
export const addCommentDtoSchema = ipcObject({
  sessionId: sessionIdSchema,
  expectedRevision: nonNegativeIntegerSchema,
  versionId: versionIdSchema,
  anchor: textQuoteAnchorDtoSchema,
  quotedText: boundedText(20_000, 1),
  body: trimmedText(20_000),
});
export const editCommentDtoSchema = ipcObject({
  sessionId: sessionIdSchema,
  expectedRevision: nonNegativeIntegerSchema,
  commentId: commentIdSchema,
  expectedCommentRevision: nonNegativeIntegerSchema,
  anchor: textQuoteAnchorDtoSchema,
  quotedText: boundedText(20_000, 1),
  body: trimmedText(20_000),
});
export const deleteCommentDtoSchema = ipcObject({
  sessionId: sessionIdSchema,
  expectedRevision: nonNegativeIntegerSchema,
  commentId: commentIdSchema,
  expectedCommentRevision: nonNegativeIntegerSchema,
});
export const retrievalQueryDtoSchema = ipcObject({
  sessionId: sessionIdSchema,
  expectedRevision: nonNegativeIntegerSchema,
  query: boundedText(100_000),
  topK: z.number().int().min(1).max(20).default(5),
});
export const retrievalViewDtoSchema = ipcObject({
  reportId: retrievalReportIdSchema,
  knowledgeVersion: trimmedText(128),
  retrievalEngineVersion: trimmedText(128),
  hits: z.array(retrievalHitDtoSchema).max(20),
  missingFacts: z.array(z.enum(['date', 'location', 'organizer'])).max(3),
  project: projectViewDtoSchema,
});

const promptPrepareFields = {
  sessionId: sessionIdSchema,
  expectedRevision: nonNegativeIntegerSchema,
  kind: taskKindDtoSchema,
  parentVersionId: versionIdSchema.nullable(),
  retrievalReportId: retrievalReportIdSchema.optional(),
  retrievalEnabled: z.boolean().optional(),
  newSupplementalFacts: boundedText(100_000, 1).optional(),
  taskConfig: generationConfigOverridesDtoSchema.optional(),
  factOverrides: factOverridesDtoSchema.optional(),
} as const;

export const preparePromptDtoSchema = ipcObject(promptPrepareFields).superRefine(
  (value, context) => {
    if (value.kind === 'draftGeneration' && value.parentVersionId !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Draft generation cannot have a parent version',
      });
    }
    if (value.kind !== 'draftGeneration' && value.parentVersionId === null) {
      context.addIssue({ code: 'custom', message: 'Review and revision require a parent version' });
    }
    if (value.kind !== 'draftGeneration' && value.retrievalReportId !== undefined) {
      context.addIssue({ code: 'custom', message: 'Only draft generation can use retrieval' });
    }
    if (
      value.kind === 'draftGeneration' &&
      value.retrievalEnabled === false &&
      value.retrievalReportId !== undefined
    ) {
      context.addIssue({ code: 'custom', message: 'Disabled retrieval cannot include a report' });
    }
    if (value.kind !== 'aiReview' && value.newSupplementalFacts !== undefined) {
      context.addIssue({ code: 'custom', message: 'Only review can add supplemental facts' });
    }
  },
);

export const factCheckItemDtoSchema = ipcObject({
  status: z.enum(['present', 'missing']),
  evidence: boundedText(1_000, 1).optional(),
  source: z.enum(['detected', 'user']).default('detected'),
});

export const promptPreparationDtoSchema = ipcObject({
  schemaVersion: z.literal(1),
  purpose: taskKindDtoSchema,
  messages: z.tuple([v1UserPromptMessageDtoSchema]),
  inputFingerprint: sha256Schema,
  resolvedConfig: resolvedGenerationConfigDtoSchema,
  factCheck: ipcObject({
    date: factCheckItemDtoSchema,
    location: factCheckItemDtoSchema,
    organizer: factCheckItemDtoSchema,
    time: factCheckItemDtoSchema,
    blocking: z.boolean(),
  }),
  risks: z.array(
    ipcObject({
      code: z.enum(['MISSING_FACTS', 'SUPPLEMENT_CONFLICT']),
      severity: z.literal('blocking'),
      message: trimmedText(500),
    }),
  ),
  trace: ipcObject({
    minutes: ipcObject({ revisionId: minuteRevisionIdSchema, sha256: sha256Schema }),
    parent: ipcObject({ versionId: versionIdSchema, contentSha256: sha256Schema }).nullable(),
    supplement: ipcObject({ present: z.boolean(), sha256: sha256Schema }),
    retrieval: retrievalTraceDtoSchema,
    comments: ipcObject({ count: z.number().int().nonnegative(), sha256: sha256Schema }),
    writingRulesVersion: trimmedText(128),
    profileSnapshot: writingProfileSnapshotDtoSchema.optional(),
  }),
  factOverrides: factOverridesDtoSchema.optional(),
});

export const startTaskDtoSchema = ipcObject({
  ...promptPrepareFields,
  messages: z.tuple([v1UserPromptMessageDtoSchema]),
  editedByUser: z.boolean(),
  editWarningAcknowledged: z.boolean(),
  promptInputFingerprint: sha256Schema,
  staleResolution: z.enum(['current', 'regenerated', 'continued']),
  previousPromptInputFingerprint: sha256Schema.optional(),
  acknowledgedRiskCodes: z
    .array(z.enum(['MISSING_FACTS', 'SUPPLEMENT_CONFLICT']))
    .max(2)
    .default([]),
  reviewEnabled: z.boolean().optional(),
}).superRefine((value, context) => {
  if (value.editedByUser !== value.editWarningAcknowledged) {
    context.addIssue({
      code: 'custom',
      message: 'Edited Prompt warning acknowledgement is invalid',
    });
  }
  if (value.kind === 'draftGeneration' && value.parentVersionId !== null) {
    context.addIssue({ code: 'custom', message: 'Draft generation cannot have a parent version' });
  }
  if (value.kind !== 'draftGeneration' && value.parentVersionId === null) {
    context.addIssue({
      code: 'custom',
      message: 'Review and revision tasks require a parent version',
    });
  }
  if (
    value.kind === 'draftGeneration' &&
    value.retrievalEnabled === false &&
    value.retrievalReportId !== undefined
  ) {
    context.addIssue({ code: 'custom', message: 'Disabled retrieval cannot include a report' });
  }
  if (
    value.staleResolution === 'regenerated' &&
    value.previousPromptInputFingerprint === undefined
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Regenerated Prompt requires a previous fingerprint',
    });
  }
  if (
    value.staleResolution !== 'regenerated' &&
    value.previousPromptInputFingerprint !== undefined
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Only regenerated Prompt uses a previous fingerprint',
    });
  }
});

export const userConfigViewDtoSchema = ipcObject({
  revision: nonNegativeIntegerSchema,
  config: generationConfigOverridesDtoSchema,
});
export const updateUserConfigDtoSchema = ipcObject({
  expectedRevision: nonNegativeIntegerSchema,
  config: generationConfigOverridesDtoSchema,
});
export const previewConfigDtoSchema = ipcObject({
  sessionId: sessionIdSchema,
  expectedRevision: nonNegativeIntegerSchema,
  taskConfig: generationConfigOverridesDtoSchema.optional(),
});
export const cancelTaskDtoSchema = ipcObject({
  sessionId: sessionIdSchema,
  expectedRevision: nonNegativeIntegerSchema,
  taskId: taskIdSchema,
});
export const cancelTaskResultDtoSchema = ipcObject({
  disposition: z.enum(['accepted', 'alreadyRequested', 'savingOrFinished']),
});
export const provideSupplementDtoSchema = ipcObject({
  sessionId: sessionIdSchema,
  expectedRevision: nonNegativeIntegerSchema,
  taskId: taskIdSchema,
  supplementalFacts: boundedText(100_000),
});
export const closedResultDtoSchema = ipcObject({ closed: z.literal(true) });

export const taskStatusEventDtoSchema = ipcObject({
  sessionId: sessionIdSchema,
  taskId: taskIdSchema,
  status: taskStatusDtoSchema,
  occurredAt: timestampSchema,
  error: safeAppErrorSchema.optional(),
});

export const ipcResultSchema = <T extends z.ZodType>(dataSchema: T) =>
  z.union([
    ipcObject({
      protocolVersion: z.literal(IPC_PROTOCOL_VERSION),
      ok: z.literal(true),
      data: dataSchema,
    }),
    ipcObject({
      protocolVersion: z.literal(IPC_PROTOCOL_VERSION),
      ok: z.literal(false),
      error: safeAppErrorSchema,
    }),
  ]);

export const IPC_CHANNELS = Object.freeze({
  runtimeGetInfo: 'nw:v1:runtime:get-info',
  authGetStatus: 'nw:v1:auth:get-status',
  authSetDeepSeekApiKey: 'nw:v1:auth:set-deepseek-api-key',
  authClearDeepSeekApiKey: 'nw:v1:auth:clear-deepseek-api-key',
  projectsCreateWithDialog: 'nw:v1:projects:create-with-dialog',
  projectsOpenWithDialog: 'nw:v1:projects:open-with-dialog',
  projectsResumeOwned: 'nw:v1:projects:resume-owned',
  projectsRecoverOpen: 'nw:v1:projects:recover-open',
  projectsClose: 'nw:v1:projects:close',
  projectsRefresh: 'nw:v1:projects:refresh',
  projectsSaveMinutes: 'nw:v1:projects:save-minutes',
  projectsImportMinutesWithDialog: 'nw:v1:projects:import-minutes-with-dialog',
  projectsUpdateConfig: 'nw:v1:projects:update-config',
  projectsSetArchived: 'nw:v1:projects:set-archived',
  projectsSetLatestVersion: 'nw:v1:projects:set-latest-version',
  promptsPrepare: 'nw:v1:prompts:prepare',
  settingsGetUserConfig: 'nw:v1:settings:get-user-config',
  settingsUpdateUserConfig: 'nw:v1:settings:update-user-config',
  settingsPreviewConfig: 'nw:v1:settings:preview-config',
  commentsAdd: 'nw:v1:comments:add',
  commentsEdit: 'nw:v1:comments:edit',
  commentsDelete: 'nw:v1:comments:delete',
  retrievalSearch: 'nw:v1:retrieval:search',
  tasksStart: 'nw:v1:tasks:start',
  tasksCancel: 'nw:v1:tasks:cancel',
  tasksProvideSupplement: 'nw:v1:tasks:provide-supplement',
  tasksStatusEvent: 'nw:v1:tasks:status',
  documentsExportWithDialog: 'nw:v1:documents:export-with-dialog',
} as const);

const invokeContract = <Request extends z.ZodType, Data extends z.ZodType>(
  request: Request,
  data: Data,
) => Object.freeze({ request, result: ipcResultSchema(data) });

export const IPC_INVOKE_CONTRACTS = Object.freeze({
  [IPC_CHANNELS.runtimeGetInfo]: invokeContract(emptyRequestSchema, runtimeInfoDtoSchema),
  [IPC_CHANNELS.authGetStatus]: invokeContract(emptyRequestSchema, authStatusDtoSchema),
  [IPC_CHANNELS.authSetDeepSeekApiKey]: invokeContract(
    setDeepSeekApiKeyDtoSchema,
    authStatusDtoSchema,
  ),
  [IPC_CHANNELS.authClearDeepSeekApiKey]: invokeContract(
    clearDeepSeekApiKeyDtoSchema,
    authStatusDtoSchema,
  ),
  [IPC_CHANNELS.projectsCreateWithDialog]: invokeContract(
    createProjectDtoSchema,
    dialogResultSchema(projectViewDtoSchema),
  ),
  [IPC_CHANNELS.projectsOpenWithDialog]: invokeContract(
    emptyRequestSchema,
    projectOpenDialogResultSchema,
  ),
  [IPC_CHANNELS.projectsResumeOwned]: invokeContract(
    emptyRequestSchema,
    resumeOwnedProjectResultSchema,
  ),
  [IPC_CHANNELS.projectsRecoverOpen]: invokeContract(
    recoverProjectOpenDtoSchema,
    projectViewDtoSchema,
  ),
  [IPC_CHANNELS.projectsClose]: invokeContract(sessionRequestSchema, closedResultDtoSchema),
  [IPC_CHANNELS.projectsRefresh]: invokeContract(sessionRequestSchema, projectViewDtoSchema),
  [IPC_CHANNELS.projectsSaveMinutes]: invokeContract(saveMinutesDtoSchema, projectViewDtoSchema),
  [IPC_CHANNELS.projectsImportMinutesWithDialog]: invokeContract(
    sessionRevisionDtoSchema,
    dialogResultSchema(projectViewDtoSchema),
  ),
  [IPC_CHANNELS.projectsUpdateConfig]: invokeContract(
    updateProjectConfigDtoSchema,
    projectViewDtoSchema,
  ),
  [IPC_CHANNELS.projectsSetArchived]: invokeContract(setArchivedDtoSchema, projectViewDtoSchema),
  [IPC_CHANNELS.projectsSetLatestVersion]: invokeContract(
    setLatestVersionDtoSchema,
    projectViewDtoSchema,
  ),
  [IPC_CHANNELS.promptsPrepare]: invokeContract(preparePromptDtoSchema, promptPreparationDtoSchema),
  [IPC_CHANNELS.settingsGetUserConfig]: invokeContract(emptyRequestSchema, userConfigViewDtoSchema),
  [IPC_CHANNELS.settingsUpdateUserConfig]: invokeContract(
    updateUserConfigDtoSchema,
    userConfigViewDtoSchema,
  ),
  [IPC_CHANNELS.settingsPreviewConfig]: invokeContract(
    previewConfigDtoSchema,
    resolvedGenerationConfigDtoSchema,
  ),
  [IPC_CHANNELS.commentsAdd]: invokeContract(addCommentDtoSchema, projectViewDtoSchema),
  [IPC_CHANNELS.commentsEdit]: invokeContract(editCommentDtoSchema, projectViewDtoSchema),
  [IPC_CHANNELS.commentsDelete]: invokeContract(deleteCommentDtoSchema, projectViewDtoSchema),
  [IPC_CHANNELS.retrievalSearch]: invokeContract(retrievalQueryDtoSchema, retrievalViewDtoSchema),
  [IPC_CHANNELS.tasksStart]: invokeContract(startTaskDtoSchema, taskViewDtoSchema),
  [IPC_CHANNELS.tasksCancel]: invokeContract(cancelTaskDtoSchema, cancelTaskResultDtoSchema),
  [IPC_CHANNELS.tasksProvideSupplement]: invokeContract(
    provideSupplementDtoSchema,
    taskViewDtoSchema,
  ),
  [IPC_CHANNELS.documentsExportWithDialog]: invokeContract(
    exportDocumentDtoSchema,
    exportDocumentResultDtoSchema,
  ),
});

export const IPC_EVENT_CONTRACTS = Object.freeze({
  [IPC_CHANNELS.tasksStatusEvent]: taskStatusEventDtoSchema,
});

export type IpcInvokeChannel = keyof typeof IPC_INVOKE_CONTRACTS;
export type IpcEventChannel = keyof typeof IPC_EVENT_CONTRACTS;

export type IpcResult<T> =
  | { protocolVersion: 1; ok: true; data: T }
  | { protocolVersion: 1; ok: false; error: z.infer<typeof safeAppErrorSchema> };
export type DialogResult<T> = { cancelled: true } | { cancelled: false; data: T };
export type ProjectLockRecoveryDescriptor = z.infer<typeof projectLockRecoveryDescriptorSchema>;
export type ProjectOpenDialogResult = z.infer<typeof projectOpenDialogResultSchema>;
export type ResumeOwnedProjectResult = z.infer<typeof resumeOwnedProjectResultSchema>;
export type RuntimeInfoDto = z.infer<typeof runtimeInfoDtoSchema>;
export type AuthStatusDto = z.infer<typeof authStatusDtoSchema>;
export type ResolvedGenerationConfigDto = z.infer<typeof resolvedGenerationConfigDtoSchema>;
export type ProjectViewDto = z.infer<typeof projectViewDtoSchema>;
export type CreateProjectDto = z.infer<typeof createProjectDtoSchema>;
export type SessionRequest = z.infer<typeof sessionRequestSchema>;
export type SessionRevisionDto = z.infer<typeof sessionRevisionDtoSchema>;
export type SaveMinutesDto = z.infer<typeof saveMinutesDtoSchema>;
export type UpdateProjectConfigDto = z.infer<typeof updateProjectConfigDtoSchema>;
export type SetArchivedDto = z.infer<typeof setArchivedDtoSchema>;
export type SetLatestVersionDto = z.infer<typeof setLatestVersionDtoSchema>;
export type RecoverProjectOpenDto = z.infer<typeof recoverProjectOpenDtoSchema>;
export type AddCommentDto = z.infer<typeof addCommentDtoSchema>;
export type EditCommentDto = z.infer<typeof editCommentDtoSchema>;
export type DeleteCommentDto = z.infer<typeof deleteCommentDtoSchema>;
export type RetrievalQueryDto = z.infer<typeof retrievalQueryDtoSchema>;
export type RetrievalViewDto = z.infer<typeof retrievalViewDtoSchema>;
export type StartTaskDto = z.infer<typeof startTaskDtoSchema>;
export type PreparePromptDto = z.infer<typeof preparePromptDtoSchema>;
export type PromptPreparationDto = z.infer<typeof promptPreparationDtoSchema>;
export type UserConfigViewDto = z.infer<typeof userConfigViewDtoSchema>;
export type UpdateUserConfigDto = z.infer<typeof updateUserConfigDtoSchema>;
export type PreviewConfigDto = z.infer<typeof previewConfigDtoSchema>;
export type CancelTaskDto = z.infer<typeof cancelTaskDtoSchema>;
export type CancelTaskResultDto = z.infer<typeof cancelTaskResultDtoSchema>;
export type ProvideSupplementDto = z.infer<typeof provideSupplementDtoSchema>;
export type TaskViewDto = z.infer<typeof taskViewDtoSchema>;
export type TaskStatusEventDto = z.infer<typeof taskStatusEventDtoSchema>;
export type ExportDocumentDto = z.infer<typeof exportDocumentDtoSchema>;
export type ExportDocumentResultDto = z.infer<typeof exportDocumentResultDtoSchema>;
export type ExportRecordViewDto = z.infer<typeof exportRecordViewDtoSchema>;

export interface NewsWriterApiV1 {
  runtime: { getInfo(): Promise<IpcResult<RuntimeInfoDto>> };
  auth: {
    getStatus(): Promise<IpcResult<AuthStatusDto>>;
    setDeepSeekApiKey(input: { apiKey: string }): Promise<IpcResult<AuthStatusDto>>;
    clearDeepSeekApiKey(input: { confirmed: true }): Promise<IpcResult<AuthStatusDto>>;
  };
  projects: {
    createWithDialog(input: CreateProjectDto): Promise<IpcResult<DialogResult<ProjectViewDto>>>;
    openWithDialog(): Promise<IpcResult<ProjectOpenDialogResult>>;
    resumeOwned(): Promise<IpcResult<ResumeOwnedProjectResult>>;
    recoverOpen(input: RecoverProjectOpenDto): Promise<IpcResult<ProjectViewDto>>;
    close(input: SessionRequest): Promise<IpcResult<{ closed: true }>>;
    refresh(input: SessionRequest): Promise<IpcResult<ProjectViewDto>>;
    saveMinutes(input: SaveMinutesDto): Promise<IpcResult<ProjectViewDto>>;
    importMinutesWithDialog(
      input: SessionRevisionDto,
    ): Promise<IpcResult<DialogResult<ProjectViewDto>>>;
    updateConfig(input: UpdateProjectConfigDto): Promise<IpcResult<ProjectViewDto>>;
    setArchived(input: SetArchivedDto): Promise<IpcResult<ProjectViewDto>>;
    setLatestVersion(input: SetLatestVersionDto): Promise<IpcResult<ProjectViewDto>>;
  };
  comments: {
    add(input: AddCommentDto): Promise<IpcResult<ProjectViewDto>>;
    edit(input: EditCommentDto): Promise<IpcResult<ProjectViewDto>>;
    delete(input: DeleteCommentDto): Promise<IpcResult<ProjectViewDto>>;
  };
  prompts: { prepare(input: PreparePromptDto): Promise<IpcResult<PromptPreparationDto>> };
  settings: {
    getUserConfig(): Promise<IpcResult<UserConfigViewDto>>;
    updateUserConfig(input: UpdateUserConfigDto): Promise<IpcResult<UserConfigViewDto>>;
    previewConfig(
      input: PreviewConfigDto,
    ): Promise<IpcResult<z.infer<typeof resolvedGenerationConfigDtoSchema>>>;
  };
  retrieval: { search(input: RetrievalQueryDto): Promise<IpcResult<RetrievalViewDto>> };
  tasks: {
    start(input: StartTaskDto): Promise<IpcResult<TaskViewDto>>;
    cancel(input: CancelTaskDto): Promise<IpcResult<CancelTaskResultDto>>;
    provideSupplement(input: ProvideSupplementDto): Promise<IpcResult<TaskViewDto>>;
    onStatus(listener: (event: TaskStatusEventDto) => void): () => void;
  };
  documents: {
    exportWithDialog(input: ExportDocumentDto): Promise<IpcResult<ExportDocumentResultDto>>;
  };
}
