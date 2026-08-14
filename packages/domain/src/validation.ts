import { compareTimestamps, type TextArtifactRef } from '@news-writer/shared';

import {
  canTransitionTask,
  projectAggregateSchema,
  type ProjectAggregateV1,
  type TaskRecord,
} from './schemas.js';

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
}

export interface ArtifactReader {
  readText(ref: TextArtifactRef): string | undefined;
}

const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled', 'timedOut']);

const duplicateIssues = <T>(
  values: readonly T[],
  id: (value: T) => string,
  path: string,
): ValidationIssue[] => {
  const seen = new Set<string>();
  const issues: ValidationIssue[] = [];
  values.forEach((value, index) => {
    const identifier = id(value);
    if (seen.has(identifier)) {
      issues.push({ code: 'DUPLICATE_ID', path: `${path}.${index}`, message: identifier });
    }
    seen.add(identifier);
  });
  return issues;
};

const sameConfig = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const validateTaskHistory = (task: TaskRecord, index: number): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  if (task.sequence !== task.history.length - 1) {
    issues.push({
      code: 'TASK_SEQUENCE_INVALID',
      path: `tasks.${index}.sequence`,
      message: 'Task sequence must match immutable history length',
    });
  }
  for (let historyIndex = 1; historyIndex < task.history.length; historyIndex += 1) {
    const previous = task.history[historyIndex - 1];
    const current = task.history[historyIndex];
    if (
      previous !== undefined &&
      current !== undefined &&
      !canTransitionTask(previous.status, current.status)
    ) {
      issues.push({
        code: 'TASK_TRANSITION_INVALID',
        path: `tasks.${index}.history.${historyIndex}`,
        message: `${previous.status} -> ${current.status}`,
      });
    }
  }
  return issues;
};

export const validateProjectAggregate = (
  rawProject: unknown,
  artifacts?: ArtifactReader,
): ValidationIssue[] => {
  const parsed = projectAggregateSchema.safeParse(rawProject);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      code: 'SCHEMA_INVALID',
      path: issue.path.join('.'),
      message: issue.message,
    }));
  }

  const project = parsed.data;
  const issues: ValidationIssue[] = [];
  issues.push(...duplicateIssues(project.prompts, (value) => value.id, 'prompts'));
  issues.push(...duplicateIssues(project.tasks, (value) => value.id, 'tasks'));
  issues.push(...duplicateIssues(project.versions, (value) => value.id, 'versions'));
  issues.push(...duplicateIssues(project.comments, (value) => value.id, 'comments'));
  issues.push(
    ...duplicateIssues(project.retrievalReports, (value) => value.id, 'retrievalReports'),
  );
  issues.push(...duplicateIssues(project.exportRecords, (value) => value.id, 'exportRecords'));

  const prompts = new Map(project.prompts.map((prompt) => [prompt.id, prompt]));
  const tasks = new Map(project.tasks.map((task) => [task.id, task]));
  const versions = new Map(project.versions.map((version) => [version.id, version]));
  const retrieval = new Set(project.retrievalReports.map((report) => report.id));

  if (project.versions.length === 0) {
    if (project.latestVersionId !== null) {
      issues.push({ code: 'LATEST_INVALID', path: 'latestVersionId', message: 'Must be null' });
    }
  } else if (project.latestVersionId === null || !versions.has(project.latestVersionId)) {
    issues.push({ code: 'LATEST_INVALID', path: 'latestVersionId', message: 'Missing version' });
  }

  const roots = project.versions.filter((version) => version.parentVersionId === null);
  if (project.versions.length > 0 && roots.length !== 1) {
    issues.push({ code: 'VERSION_ROOT_INVALID', path: 'versions', message: 'Expected one root' });
  }

  project.versions.forEach((version, index) => {
    if (
      version.parentVersionId !== null &&
      (!versions.has(version.parentVersionId) || version.parentVersionId === version.id)
    ) {
      issues.push({
        code: 'VERSION_PARENT_INVALID',
        path: `versions.${index}.parentVersionId`,
        message: 'Missing or self parent',
      });
    }
    const task = tasks.get(version.taskId);
    if (
      task?.status !== 'succeeded' ||
      task.resultVersionId !== version.id ||
      task.promptId !== version.sourcePromptId ||
      task.parentVersionId !== version.parentVersionId ||
      task.kind !== version.createdBy ||
      !sameConfig(task.configSnapshot, version.configSnapshot)
    ) {
      issues.push({
        code: 'VERSION_TASK_MISMATCH',
        path: `versions.${index}`,
        message: 'Version and succeeded task are inconsistent',
      });
    }
    if (version.configSnapshot.profile !== project.profile) {
      issues.push({
        code: 'CONFIG_PROFILE_MISMATCH',
        path: `versions.${index}.configSnapshot`,
        message: '',
      });
    }
    if (artifacts !== undefined) {
      const content = artifacts.readText(version.contentRef);
      if (content === undefined || content.trim().length === 0) {
        issues.push({
          code: 'VERSION_CONTENT_INVALID',
          path: `versions.${index}.contentRef`,
          message: '',
        });
      }
    }
  });

  for (const version of project.versions) {
    const visited = new Set<string>();
    let current: typeof version | undefined = version;
    while (current !== undefined) {
      if (visited.has(current.id)) {
        issues.push({ code: 'VERSION_CYCLE', path: 'versions', message: current.id });
        break;
      }
      visited.add(current.id);
      current =
        current.parentVersionId === null ? undefined : versions.get(current.parentVersionId);
    }
  }

  const promptUse = new Set<string>();
  project.tasks.forEach((task, index) => {
    issues.push(...validateTaskHistory(task, index));
    const prompt = prompts.get(task.promptId);
    if (prompt === undefined || prompt.purpose !== task.kind || promptUse.has(task.promptId)) {
      issues.push({ code: 'TASK_PROMPT_INVALID', path: `tasks.${index}.promptId`, message: '' });
    }
    promptUse.add(task.promptId);
    if (task.configSnapshot.profile !== project.profile) {
      issues.push({
        code: 'CONFIG_PROFILE_MISMATCH',
        path: `tasks.${index}.configSnapshot`,
        message: '',
      });
    }
    if (task.retrievalReportId !== undefined && !retrieval.has(task.retrievalReportId)) {
      issues.push({
        code: 'RETRIEVAL_MISSING',
        path: `tasks.${index}.retrievalReportId`,
        message: '',
      });
    }
    if (task.kind === 'draftGeneration') {
      if (task.parentVersionId !== null || task.expectedLatestVersionId !== null) {
        issues.push({ code: 'TASK_PARENT_INVALID', path: `tasks.${index}`, message: '' });
      }
    } else if (
      task.parentVersionId === null ||
      task.parentVersionId !== task.expectedLatestVersionId ||
      !versions.has(task.parentVersionId)
    ) {
      issues.push({ code: 'TASK_PARENT_INVALID', path: `tasks.${index}`, message: '' });
    }
    if (
      task.kind === 'commentRevision' &&
      task.commentSnapshot.some((comment) => comment.versionId !== task.parentVersionId)
    ) {
      issues.push({
        code: 'COMMENT_SNAPSHOT_INVALID',
        path: `tasks.${index}.commentSnapshot`,
        message: '',
      });
    }
    if (task.kind === 'commentRevision') {
      const snapshotIds = new Set<string>();
      task.commentSnapshot.forEach((comment, commentIndex) => {
        if (snapshotIds.has(comment.id)) {
          issues.push({
            code: 'COMMENT_SNAPSHOT_INVALID',
            path: `tasks.${index}.commentSnapshot.${commentIndex}`,
            message: 'Duplicate comment snapshot',
          });
        }
        snapshotIds.add(comment.id);
        const previous = task.commentSnapshot[commentIndex - 1];
        if (
          previous !== undefined &&
          (previous.anchor.start > comment.anchor.start ||
            (previous.anchor.start === comment.anchor.start &&
              previous.anchor.end > comment.anchor.end) ||
            (previous.anchor.start === comment.anchor.start &&
              previous.anchor.end === comment.anchor.end &&
              compareTimestamps(previous.createdAt, comment.createdAt) > 0) ||
            (previous.anchor.start === comment.anchor.start &&
              previous.anchor.end === comment.anchor.end &&
              compareTimestamps(previous.createdAt, comment.createdAt) === 0 &&
              previous.id.localeCompare(comment.id) > 0))
        ) {
          issues.push({
            code: 'COMMENT_SNAPSHOT_INVALID',
            path: `tasks.${index}.commentSnapshot.${commentIndex}`,
            message: 'Comment snapshot order is unstable',
          });
        }
        const version = versions.get(comment.versionId);
        if (version === undefined || comment.anchor.contentSha256 !== version.contentRef.sha256) {
          issues.push({
            code: 'COMMENT_SNAPSHOT_INVALID',
            path: `tasks.${index}.commentSnapshot.${commentIndex}.anchor`,
            message: 'Comment snapshot anchor hash is invalid',
          });
        } else if (artifacts !== undefined) {
          const content = artifacts.readText(version.contentRef);
          if (
            content === undefined ||
            content.slice(comment.anchor.start, comment.anchor.end) !== comment.anchor.exact ||
            (comment.anchor.prefix.length > 0 &&
              content.slice(
                Math.max(0, comment.anchor.start - comment.anchor.prefix.length),
                comment.anchor.start,
              ) !== comment.anchor.prefix) ||
            (comment.anchor.suffix.length > 0 &&
              content.slice(
                comment.anchor.end,
                comment.anchor.end + comment.anchor.suffix.length,
              ) !== comment.anchor.suffix)
          ) {
            issues.push({
              code: 'COMMENT_SNAPSHOT_INVALID',
              path: `tasks.${index}.commentSnapshot.${commentIndex}.anchor`,
              message: 'Comment snapshot anchor text is invalid',
            });
          }
        }
      });
    }
  });
  project.prompts.forEach((prompt, index) => {
    if (!promptUse.has(prompt.id)) {
      issues.push({ code: 'PROMPT_ORPHANED', path: `prompts.${index}`, message: '' });
    }
  });

  const activeTasks = project.tasks.filter((task) => !terminalStatuses.has(task.status));
  if (activeTasks.length > 1) {
    issues.push({ code: 'MULTIPLE_ACTIVE_TASKS', path: 'tasks', message: '' });
  }

  project.comments.forEach((comment, index) => {
    const version = versions.get(comment.versionId);
    if (version === undefined) {
      issues.push({
        code: 'COMMENT_VERSION_MISSING',
        path: `comments.${index}.versionId`,
        message: '',
      });
      return;
    }
    if (comment.anchor.contentSha256 !== version.contentRef.sha256) {
      issues.push({
        code: 'COMMENT_ANCHOR_INVALID',
        path: `comments.${index}.anchor`,
        message: 'Hash mismatch',
      });
    }
    if (artifacts !== undefined) {
      const content = artifacts.readText(version.contentRef);
      if (
        content === undefined ||
        content.slice(comment.anchor.start, comment.anchor.end) !== comment.anchor.exact ||
        (comment.anchor.prefix.length > 0 &&
          content.slice(
            Math.max(0, comment.anchor.start - comment.anchor.prefix.length),
            comment.anchor.start,
          ) !== comment.anchor.prefix) ||
        (comment.anchor.suffix.length > 0 &&
          content.slice(comment.anchor.end, comment.anchor.end + comment.anchor.suffix.length) !==
            comment.anchor.suffix)
      ) {
        issues.push({
          code: 'COMMENT_ANCHOR_INVALID',
          path: `comments.${index}.anchor`,
          message: 'Text mismatch',
        });
      }
    }
  });

  project.exportRecords.forEach((record, index) => {
    if (!versions.has(record.versionId)) {
      issues.push({
        code: 'EXPORT_VERSION_MISSING',
        path: `exportRecords.${index}.versionId`,
        message: '',
      });
    }
  });

  for (const task of project.tasks) {
    if (task.status === 'succeeded') {
      const matches = project.versions.filter((version) => version.taskId === task.id);
      if (matches.length !== 1) {
        issues.push({ code: 'SUCCEEDED_TASK_VERSION_INVALID', path: 'tasks', message: task.id });
      }
    }
  }

  return issues;
};

export const assertValidProjectAggregate = (
  project: unknown,
  artifacts?: ArtifactReader,
): ProjectAggregateV1 => {
  const parsed = projectAggregateSchema.parse(project);
  const issues = validateProjectAggregate(parsed, artifacts);
  if (issues.length > 0) {
    throw new AggregateValidationError(issues);
  }
  return parsed;
};

export class AggregateValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super('Project aggregate validation failed');
    this.name = 'AggregateValidationError';
    this.issues = issues;
  }
}
