import {
  commentIdSchema,
  minuteIdSchema,
  minuteRevisionIdSchema,
  projectIdSchema,
  promptIdSchema,
  taskIdSchema,
  timestampSchema,
  versionIdSchema,
  type Clock,
  type IdGenerator,
  type RuntimeVersionSnapshot,
  type SafeAppError,
  type TextArtifactRef,
  type Timestamp,
  type VersionId,
} from '@news-writer/shared';

import {
  canTransitionTask,
  commentRecordSchema,
  exportRecordSchema,
  generationConfigOverridesSchema,
  minutesSnapshotSchema,
  promptRecordSchema,
  queueTaskInputSchema,
  retrievalReportSchema,
  taskRecordSchema,
  versionRecordSchema,
  type CommentRecord,
  type ExportRecord,
  type GenerationConfigOverrides,
  type ProjectAggregateV1,
  type ProjectProfile,
  type QueueTaskInput,
  type RetrievalReport,
  type TaskRecord,
  type TextQuoteAnchor,
  type VersionRecord,
  type WritingProfileSnapshot,
} from './schemas.js';
import { resolveGenerationConfig } from './config.js';
import { orderCommentSnapshots } from './prompt-preparation.js';
import { assertValidProjectAggregate, type ArtifactReader } from './validation.js';

export type DomainErrorCode =
  | 'ARCHIVED_PROJECT'
  | 'COMMENT_NOT_EDITABLE'
  | 'CONTENT_INVALID'
  | 'ENTITY_NOT_FOUND'
  | 'PROFILE_LOCKED'
  | 'REVISION_CONFLICT'
  | 'STATE_CONFLICT';

export class DomainRuleError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainRuleError';
    this.code = code;
  }
}

const assertRevision = (project: ProjectAggregateV1, expectedRevision: number): void => {
  if (project.revision !== expectedRevision) {
    throw new DomainRuleError('REVISION_CONFLICT', 'Project revision is stale');
  }
};

const assertActive = (project: ProjectAggregateV1): void => {
  if (project.status !== 'active') {
    throw new DomainRuleError('ARCHIVED_PROJECT', 'Archived projects are read-only');
  }
};

const hasActiveTask = (project: ProjectAggregateV1): boolean =>
  project.tasks.some((task) =>
    ['queued', 'preparing', 'requesting', 'processing', 'reviewing', 'saving'].includes(
      task.status,
    ),
  );

const assertNoActiveTask = (project: ProjectAggregateV1): void => {
  if (hasActiveTask(project)) {
    throw new DomainRuleError('STATE_CONFLICT', 'An active task must finish first');
  }
};

const withRevision = (
  project: ProjectAggregateV1,
  at: Timestamp,
  runtime: RuntimeVersionSnapshot,
  changes: Partial<ProjectAggregateV1>,
): ProjectAggregateV1 =>
  assertValidProjectAggregate({
    ...project,
    ...changes,
    revision: project.revision + 1,
    updatedAt: at,
    lastWrittenWith: runtime,
  });

const parseGeneratedId = <T>(schema: { parse(value: unknown): T }, value: string): T =>
  schema.parse(value);

export interface CreateProjectInput {
  name: string;
  profile: ProjectProfile;
  minutesContentRef: TextArtifactRef;
  projectConfig?: GenerationConfigOverrides;
  runtime: RuntimeVersionSnapshot;
  profileSnapshot?: WritingProfileSnapshot;
}

export interface DomainDependencies {
  clock: Clock;
  ids: IdGenerator;
  runtime: RuntimeVersionSnapshot;
}

export const createProject = (
  input: CreateProjectInput,
  dependencies: Omit<DomainDependencies, 'runtime'>,
): ProjectAggregateV1 => {
  const at = dependencies.clock.now();
  return assertValidProjectAggregate({
    format: 'news-writer-project',
    schemaVersion: 1,
    projectId: parseGeneratedId(projectIdSchema, dependencies.ids.next('project')),
    revision: 0,
    name: input.name,
    profile: input.profile,
    ...(input.profileSnapshot === undefined ? {} : { profileSnapshot: input.profileSnapshot }),
    status: 'active',
    createdAt: at,
    updatedAt: at,
    createdWith: input.runtime,
    lastWrittenWith: input.runtime,
    minutes: {
      minuteId: parseGeneratedId(minuteIdSchema, dependencies.ids.next('minute')),
      revisionId: parseGeneratedId(minuteRevisionIdSchema, dependencies.ids.next('minuteRevision')),
      createdAt: at,
      contentRef: input.minutesContentRef,
    },
    projectConfig: input.projectConfig ?? {},
    latestVersionId: null,
    prompts: [],
    tasks: [],
    versions: [],
    comments: [],
    retrievalReports: [],
    exportRecords: [],
  });
};

export const archiveProject = (
  project: ProjectAggregateV1,
  expectedRevision: number,
  at: Timestamp,
  runtime: RuntimeVersionSnapshot,
): ProjectAggregateV1 => {
  assertRevision(project, expectedRevision);
  if (project.status === 'archived') return project;
  if (
    project.tasks.some(
      (task) => !['succeeded', 'failed', 'cancelled', 'timedOut'].includes(task.status),
    )
  ) {
    throw new DomainRuleError('STATE_CONFLICT', 'An active task must finish before archiving');
  }
  return withRevision(project, at, runtime, { status: 'archived', archivedAt: at });
};

export const restoreProject = (
  project: ProjectAggregateV1,
  expectedRevision: number,
  at: Timestamp,
  runtime: RuntimeVersionSnapshot,
): ProjectAggregateV1 => {
  assertRevision(project, expectedRevision);
  if (project.status === 'active') return project;
  const restored = { ...project, status: 'active' as const };
  delete restored.archivedAt;
  return withRevision(restored, at, runtime, {});
};

export const saveMinutes = (
  project: ProjectAggregateV1,
  contentRef: TextArtifactRef,
  expectedRevision: number,
  dependencies: DomainDependencies,
): ProjectAggregateV1 => {
  assertRevision(project, expectedRevision);
  assertActive(project);
  assertNoActiveTask(project);
  const at = dependencies.clock.now();
  const minutes = minutesSnapshotSchema.parse({
    minuteId: project.minutes.minuteId,
    revisionId: parseGeneratedId(minuteRevisionIdSchema, dependencies.ids.next('minuteRevision')),
    createdAt: at,
    contentRef,
  });
  return withRevision(project, at, dependencies.runtime, { minutes });
};

export const updateProjectConfig = (
  project: ProjectAggregateV1,
  overrides: GenerationConfigOverrides,
  expectedRevision: number,
  at: Timestamp,
  runtime: RuntimeVersionSnapshot,
): ProjectAggregateV1 => {
  assertRevision(project, expectedRevision);
  assertActive(project);
  assertNoActiveTask(project);
  const projectConfig = generationConfigOverridesSchema.parse(overrides);
  if (JSON.stringify(project.projectConfig) === JSON.stringify(projectConfig)) return project;
  return withRevision(project, at, runtime, {
    projectConfig,
  });
};

export const changeProjectProfile = (
  project: ProjectAggregateV1,
  profile: ProjectProfile,
  expectedRevision: number,
  at: Timestamp,
  runtime: RuntimeVersionSnapshot,
): ProjectAggregateV1 => {
  assertRevision(project, expectedRevision);
  assertActive(project);
  assertNoActiveTask(project);
  if (project.profile === profile) return project;
  if (
    project.prompts.length +
      project.tasks.length +
      project.versions.length +
      project.comments.length +
      project.retrievalReports.length +
      project.exportRecords.length >
    0
  ) {
    throw new DomainRuleError(
      'PROFILE_LOCKED',
      'Profile cannot change after workflow records exist',
    );
  }
  return withRevision(project, at, runtime, { profile });
};

export const setLatestVersion = (
  project: ProjectAggregateV1,
  versionId: VersionId,
  expectedRevision: number,
  at: Timestamp,
  runtime: RuntimeVersionSnapshot,
): ProjectAggregateV1 => {
  assertRevision(project, expectedRevision);
  assertActive(project);
  assertNoActiveTask(project);
  if (!project.versions.some((version) => version.id === versionId)) {
    throw new DomainRuleError('ENTITY_NOT_FOUND', 'Version does not exist');
  }
  if (project.latestVersionId === versionId) return project;
  return withRevision(project, at, runtime, { latestVersionId: versionId });
};

const assertCommentTarget = (
  project: ProjectAggregateV1,
  versionId: VersionId,
  anchor: TextQuoteAnchor,
  artifacts: ArtifactReader,
): void => {
  if (project.latestVersionId !== versionId) {
    throw new DomainRuleError('COMMENT_NOT_EDITABLE', 'Only latest-version comments are editable');
  }
  const version = project.versions.find((candidate) => candidate.id === versionId);
  if (version === undefined) {
    throw new DomainRuleError('ENTITY_NOT_FOUND', 'Version does not exist');
  }
  const content = artifacts.readText(version.contentRef);
  if (
    content === undefined ||
    anchor.contentSha256 !== version.contentRef.sha256 ||
    content.slice(anchor.start, anchor.end) !== anchor.exact
  ) {
    throw new DomainRuleError('CONTENT_INVALID', 'Comment anchor does not match version content');
  }
  if (
    (anchor.prefix.length > 0 &&
      content.slice(Math.max(0, anchor.start - anchor.prefix.length), anchor.start) !==
        anchor.prefix) ||
    (anchor.suffix.length > 0 &&
      content.slice(anchor.end, anchor.end + anchor.suffix.length) !== anchor.suffix)
  ) {
    throw new DomainRuleError(
      'CONTENT_INVALID',
      'Comment anchor context does not match version content',
    );
  }
};

export interface AddCommentInput {
  versionId: VersionId;
  anchor: TextQuoteAnchor;
  body: string;
}

export const addComment = (
  project: ProjectAggregateV1,
  input: AddCommentInput,
  expectedRevision: number,
  dependencies: DomainDependencies & { artifacts: ArtifactReader },
): ProjectAggregateV1 => {
  assertRevision(project, expectedRevision);
  assertActive(project);
  assertNoActiveTask(project);
  assertCommentTarget(project, input.versionId, input.anchor, dependencies.artifacts);
  const at = dependencies.clock.now();
  const comment = commentRecordSchema.parse({
    id: parseGeneratedId(commentIdSchema, dependencies.ids.next('comment')),
    revision: 0,
    versionId: input.versionId,
    anchor: input.anchor,
    quotedText: input.anchor.exact,
    body: input.body,
    createdAt: at,
    updatedAt: at,
  });
  return withRevision(project, at, dependencies.runtime, {
    comments: [...project.comments, comment],
  });
};

export interface EditCommentInput {
  commentId: CommentRecord['id'];
  anchor: TextQuoteAnchor;
  body: string;
}

export const editComment = (
  project: ProjectAggregateV1,
  input: EditCommentInput,
  expectedRevision: number,
  at: Timestamp,
  artifacts: ArtifactReader,
  runtime: RuntimeVersionSnapshot,
): ProjectAggregateV1 => {
  assertRevision(project, expectedRevision);
  assertActive(project);
  assertNoActiveTask(project);
  const index = project.comments.findIndex((comment) => comment.id === input.commentId);
  const current = project.comments[index];
  if (current === undefined) {
    throw new DomainRuleError('ENTITY_NOT_FOUND', 'Comment does not exist');
  }
  assertCommentTarget(project, current.versionId, input.anchor, artifacts);
  const updated = commentRecordSchema.parse({
    ...current,
    revision: current.revision + 1,
    anchor: input.anchor,
    quotedText: input.anchor.exact,
    body: input.body,
    updatedAt: at,
  });
  if (
    JSON.stringify(current.anchor) === JSON.stringify(updated.anchor) &&
    current.body === updated.body
  ) {
    return project;
  }
  const comments = [...project.comments];
  comments[index] = updated;
  return withRevision(project, at, runtime, { comments });
};

export interface DeleteCommentInput {
  commentId: CommentRecord['id'];
}

export const deleteComment = (
  project: ProjectAggregateV1,
  input: DeleteCommentInput,
  expectedRevision: number,
  at: Timestamp,
  runtime: RuntimeVersionSnapshot,
): ProjectAggregateV1 => {
  assertRevision(project, expectedRevision);
  assertActive(project);
  assertNoActiveTask(project);
  const current = project.comments.find((comment) => comment.id === input.commentId);
  if (current === undefined) {
    throw new DomainRuleError('ENTITY_NOT_FOUND', 'Comment does not exist');
  }
  if (project.latestVersionId !== current.versionId) {
    throw new DomainRuleError('COMMENT_NOT_EDITABLE', 'Only latest-version comments are editable');
  }
  return withRevision(project, at, runtime, {
    comments: project.comments.filter((comment) => comment.id !== input.commentId),
  });
};

export const queueTask = (
  project: ProjectAggregateV1,
  input: QueueTaskInput,
  expectedRevision: number,
  dependencies: DomainDependencies,
): ProjectAggregateV1 => {
  assertRevision(project, expectedRevision);
  assertActive(project);
  const parsedInput = queueTaskInputSchema.parse(input);
  if (
    project.tasks.some(
      (task) => !['succeeded', 'failed', 'cancelled', 'timedOut'].includes(task.status),
    )
  ) {
    throw new DomainRuleError('STATE_CONFLICT', 'Another task is active');
  }
  const at = dependencies.clock.now();
  const parentVersionId = project.latestVersionId;
  if (
    parsedInput.kind === 'draftGeneration' ? parentVersionId !== null : parentVersionId === null
  ) {
    throw new DomainRuleError(
      'STATE_CONFLICT',
      'Task kind is incompatible with current version state',
    );
  }
  if (
    parsedInput.retrievalReportId !== undefined &&
    !project.retrievalReports.some((report) => report.id === parsedInput.retrievalReportId)
  ) {
    throw new DomainRuleError('ENTITY_NOT_FOUND', 'Retrieval report does not exist');
  }
  const configSnapshot = resolveGenerationConfig({
    profile: project.profile,
    defaults: parsedInput.config.defaults,
    project: project.projectConfig,
    ...(parsedInput.config.user === undefined ? {} : { user: parsedInput.config.user }),
    ...(parsedInput.config.task === undefined ? {} : { task: parsedInput.config.task }),
  });
  const prompt = promptRecordSchema.parse({
    id: parseGeneratedId(promptIdSchema, dependencies.ids.next('prompt')),
    createdAt: at,
    purpose: parsedInput.kind,
    messages: parsedInput.messages,
    editedByUser: parsedInput.editedByUser,
    upstream: parsedInput.upstream,
    ...(parsedInput.editWarningAcknowledgedAt === undefined
      ? {}
      : { editWarningAcknowledgedAt: parsedInput.editWarningAcknowledgedAt }),
  });
  const snapshot =
    parsedInput.kind === 'commentRevision'
      ? orderCommentSnapshots(
          project.comments.filter((comment) => comment.versionId === parentVersionId),
        ).map((ordered) => {
          const original = project.comments.find((comment) => comment.id === ordered.id);
          if (original === undefined)
            throw new DomainRuleError('ENTITY_NOT_FOUND', 'Comment missing');
          return structuredClone(original);
        })
      : [];
  if (parsedInput.kind === 'commentRevision' && snapshot.length === 0) {
    throw new DomainRuleError('STATE_CONFLICT', 'Comment revision requires at least one comment');
  }
  const task = taskRecordSchema.parse({
    id: parseGeneratedId(taskIdSchema, dependencies.ids.next('task')),
    sequence: 0,
    kind: parsedInput.kind,
    status: 'queued',
    createdAt: at,
    updatedAt: at,
    parentVersionId,
    expectedLatestVersionId: parentVersionId,
    baseProjectRevision: expectedRevision,
    promptId: prompt.id,
    configSnapshot,
    ...(parsedInput.profileSnapshot === undefined
      ? {}
      : { profileSnapshot: parsedInput.profileSnapshot }),
    minutesSnapshot: structuredClone(project.minutes),
    ...(parsedInput.factOverrides === undefined
      ? {}
      : { factOverrides: structuredClone(parsedInput.factOverrides) }),
    ...(parsedInput.retrievalReportId === undefined
      ? {}
      : { retrievalReportId: parsedInput.retrievalReportId }),
    ...(parsedInput.retrievalUnavailable === undefined
      ? {}
      : { retrievalUnavailable: parsedInput.retrievalUnavailable }),
    reviewEnabled: parsedInput.reviewEnabled ?? false,
    ...(parsedInput.kind === 'commentRevision' ? { commentSnapshotAt: at } : {}),
    commentSnapshot: snapshot,
    history: [{ status: 'queued', at }],
  });
  return withRevision(project, at, dependencies.runtime, {
    prompts: [...project.prompts, prompt],
    tasks: [...project.tasks, task],
  });
};

type TransitionPayload =
  | { status: 'preparing' | 'requesting' | 'processing' | 'reviewing' }
  | {
      status: 'saving';
      successTransactionId: string;
      proposedVersionId: VersionId;
    }
  | {
      status: 'failed' | 'cancelled' | 'timedOut';
      error: SafeAppError;
    };

export const transitionTask = (
  project: ProjectAggregateV1,
  taskId: TaskRecord['id'],
  payload: TransitionPayload,
  expectedRevision: number,
  at: Timestamp,
  runtime: RuntimeVersionSnapshot,
): ProjectAggregateV1 => {
  assertRevision(project, expectedRevision);
  assertActive(project);
  const index = project.tasks.findIndex((task) => task.id === taskId);
  const current = project.tasks[index];
  if (current === undefined) throw new DomainRuleError('ENTITY_NOT_FOUND', 'Task does not exist');
  if (!canTransitionTask(current.status, payload.status)) {
    throw new DomainRuleError('STATE_CONFLICT', 'Illegal task transition');
  }
  const next = taskRecordSchema.parse({
    ...(() => {
      const base: Record<string, unknown> = { ...current };
      delete base.successTransactionId;
      delete base.proposedVersionId;
      return base;
    })(),
    ...payload,
    sequence: current.sequence + 1,
    updatedAt: at,
    ...(['failed', 'cancelled', 'timedOut'].includes(payload.status) ? { completedAt: at } : {}),
    history: [...current.history, { status: payload.status, at }],
  });
  const tasks = [...project.tasks];
  tasks[index] = next;
  return withRevision(project, at, runtime, { tasks });
};

export interface CommitSuccessfulVersionInput {
  taskId: TaskRecord['id'];
  contentRef: TextArtifactRef;
  createdAt: Timestamp;
}

export const commitSuccessfulVersion = (
  project: ProjectAggregateV1,
  input: CommitSuccessfulVersionInput,
  expectedRevision: number,
  artifacts: ArtifactReader,
  runtime: RuntimeVersionSnapshot,
): ProjectAggregateV1 => {
  assertRevision(project, expectedRevision);
  assertActive(project);
  const taskIndex = project.tasks.findIndex((task) => task.id === input.taskId);
  const task = project.tasks[taskIndex];
  if (task?.status !== 'saving') {
    throw new DomainRuleError('STATE_CONFLICT', 'Task must be saving');
  }
  if (
    project.latestVersionId !== task.expectedLatestVersionId ||
    task.parentVersionId !== task.expectedLatestVersionId
  ) {
    throw new DomainRuleError('REVISION_CONFLICT', 'Task base state changed');
  }
  const content = artifacts.readText(input.contentRef);
  if (content === undefined || content.trim().length === 0) {
    throw new DomainRuleError('CONTENT_INVALID', 'Successful version content is empty');
  }
  const version = versionRecordSchema.parse({
    id: task.proposedVersionId,
    createdAt: input.createdAt,
    parentVersionId: task.parentVersionId,
    createdBy: task.kind,
    sourcePromptId: task.promptId,
    taskId: task.id,
    taskStatusSnapshot: 'succeeded',
    configSnapshot: task.configSnapshot,
    ...(task.profileSnapshot === undefined ? {} : { profileSnapshot: task.profileSnapshot }),
    ...(task.factOverrides === undefined
      ? {}
      : { factOverrides: structuredClone(task.factOverrides) }),
    contentRef: input.contentRef,
  });
  const succeeded = taskRecordSchema.parse({
    ...(() => {
      const base: Record<string, unknown> = { ...task };
      delete base.proposedVersionId;
      return base;
    })(),
    status: 'succeeded',
    sequence: task.sequence + 1,
    updatedAt: input.createdAt,
    completedAt: input.createdAt,
    resultVersionId: version.id,
    committedRevision: project.revision + 1,
    history: [...task.history, { status: 'succeeded', at: input.createdAt }],
  });
  const tasks = [...project.tasks];
  tasks[taskIndex] = succeeded;
  const next = withRevision(project, input.createdAt, runtime, {
    tasks,
    versions: [...project.versions, version],
    latestVersionId: version.id,
  });
  return assertValidProjectAggregate(next, artifacts);
};

export const recordRetrieval = (
  project: ProjectAggregateV1,
  report: RetrievalReport,
  expectedRevision: number,
  at: Timestamp,
  runtime: RuntimeVersionSnapshot,
): ProjectAggregateV1 => {
  assertRevision(project, expectedRevision);
  assertActive(project);
  assertNoActiveTask(project);
  const parsed = retrievalReportSchema.parse(report);
  if (project.retrievalReports.some((existing) => existing.id === parsed.id)) {
    throw new DomainRuleError('STATE_CONFLICT', 'Retrieval report already exists');
  }
  return withRevision(project, at, runtime, {
    retrievalReports: [...project.retrievalReports, parsed],
  });
};

export const recordExport = (
  project: ProjectAggregateV1,
  record: ExportRecord,
  expectedRevision: number,
  at: Timestamp,
  runtime: RuntimeVersionSnapshot,
): ProjectAggregateV1 => {
  assertRevision(project, expectedRevision);
  assertNoActiveTask(project);
  const parsed = exportRecordSchema.parse(record);
  if (!project.versions.some((version) => version.id === parsed.versionId)) {
    throw new DomainRuleError('ENTITY_NOT_FOUND', 'Export version does not exist');
  }
  if (project.exportRecords.some((existing) => existing.id === parsed.id)) {
    throw new DomainRuleError('STATE_CONFLICT', 'Export record already exists');
  }
  return withRevision(project, at, runtime, {
    exportRecords: [...project.exportRecords, parsed],
  });
};

export const getCurrentVersionChain = (project: ProjectAggregateV1): VersionRecord[] => {
  const byId = new Map(project.versions.map((version) => [version.id, version]));
  const reversed: VersionRecord[] = [];
  let current = project.latestVersionId === null ? undefined : byId.get(project.latestVersionId);
  while (current !== undefined) {
    reversed.push(current);
    current = current.parentVersionId === null ? undefined : byId.get(current.parentVersionId);
  }
  return reversed.reverse();
};

export interface BranchSummary {
  versionId: VersionRecord['id'];
  parentVersionId: VersionRecord['parentVersionId'];
  isLatest: boolean;
  isOnCurrentChain: boolean;
  childVersionIds: VersionRecord['id'][];
}

export const getBranches = (project: ProjectAggregateV1): BranchSummary[] => {
  const chain = new Set(getCurrentVersionChain(project).map((version) => version.id));
  return project.versions.map((version) => ({
    versionId: version.id,
    parentVersionId: version.parentVersionId,
    isLatest: version.id === project.latestVersionId,
    isOnCurrentChain: chain.has(version.id),
    childVersionIds: project.versions
      .filter((candidate) => candidate.parentVersionId === version.id)
      .map((candidate) => candidate.id),
  }));
};

export const parseTimestamp = (value: string): Timestamp => timestampSchema.parse(value);
export const parseVersionId = (value: string): VersionId => versionIdSchema.parse(value);
