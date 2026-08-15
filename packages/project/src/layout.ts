import { assertValidProjectAggregate, type ProjectAggregateV1 } from '@news-writer/domain';
import {
  containsSecretMaterial,
  projectRelativePathSchema,
  type ImageArtifactRef,
  type ProjectRelativePath,
  type TextArtifactRef,
} from '@news-writer/shared';

import { ProjectError } from './errors.js';
import { readLimitedFile } from './atomic.js';
import { assertExistingAncestorsHaveNoReparsePoint, resolveProjectPath } from './paths.js';
import {
  diskRecordV1Schema,
  storedObjectRefSchema,
  type DiskRecordV1,
  type ProjectStateIndexV1,
  type StoredObjectRef,
} from './schemas.js';
import { parseJsonBytes, serializeJson, sha256, verifyBytes } from './serialization.js';

export interface ArtifactInput {
  readonly bytes: Uint8Array;
  readonly ref: TextArtifactRef;
}

export type ArtifactInputs = ReadonlyMap<string, Uint8Array | string>;

export interface MaterializedProject {
  aggregate: ProjectAggregateV1;
  textArtifacts: Map<string, Buffer>;
  imageArtifacts: Map<string, Buffer>;
}

export interface CandidateObject {
  ref: StoredObjectRef;
  bytes: Buffer;
}

const recordMaxBytes = 4 * 1024 * 1024;

const assertNoCredentialMaterial = (bytes: Uint8Array): void => {
  const text = Buffer.from(bytes).toString('utf8');
  if (containsSecretMaterial([text])) {
    throw ProjectError.schemaInvalid('Credential material cannot be stored in a project');
  }
};

const recordPath = (
  kind: DiskRecordV1['kind'],
  payload: DiskRecordV1['payload'],
): ProjectRelativePath => {
  const value = payload as {
    id?: string;
    minuteId?: string;
    revision?: number;
    revisionId?: string;
    sequence?: number;
  };
  switch (kind) {
    case 'minutes':
      return projectRelativePathSchema.parse(
        `records/minutes/${value.minuteId}/${value.revisionId}.json`,
      );
    case 'prompt':
      return projectRelativePathSchema.parse(`records/prompts/${value.id}.json`);
    case 'task':
      return projectRelativePathSchema.parse(`records/tasks/${value.id}/${value.sequence}.json`);
    case 'version':
      return projectRelativePathSchema.parse(`records/versions/${value.id}.json`);
    case 'comment':
      return projectRelativePathSchema.parse(`records/comments/${value.id}/${value.revision}.json`);
    case 'retrievalReport':
      return projectRelativePathSchema.parse(`records/retrieval/${value.id}.json`);
    case 'exportRecord':
      return projectRelativePathSchema.parse(`records/exports/${value.id}.json`);
  }
};

const makeRecord = (kind: DiskRecordV1['kind'], payload: unknown): CandidateObject => {
  const candidate = diskRecordV1Schema.parse({
    format: 'news-writer-record',
    storageVersion: 1,
    schemaVersion: 1,
    kind,
    entityId:
      kind === 'minutes'
        ? (payload as { minuteId: string }).minuteId
        : (payload as { id: string }).id,
    payload,
  });
  const bytes = serializeJson(candidate);
  const relativePath = recordPath(kind, candidate.payload);
  return {
    bytes,
    ref: storedObjectRefSchema.parse({
      relativePath,
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
      kind,
      entityId: candidate.entityId,
      recordVersion: 1,
    }),
  };
};

const expectedContentPaths = (project: ProjectAggregateV1): Map<string, TextArtifactRef> => {
  const expected = new Map<string, TextArtifactRef>();
  const minutesPath = `content/minutes/${project.minutes.minuteId}/${project.minutes.revisionId}.md`;
  if (project.minutes.contentRef.relativePath !== minutesPath) {
    throw new ProjectError('PROJECT_PATH_INVALID', 'Minutes content path is inconsistent');
  }
  expected.set(project.minutes.contentRef.relativePath, project.minutes.contentRef);

  const promptTasks = new Map(project.tasks.map((task) => [task.promptId, task]));
  for (const prompt of project.prompts) {
    const task = promptTasks.get(prompt.id);
    if (task === undefined) throw ProjectError.schemaInvalid('Prompt has no task owner');
    prompt.messages.forEach((message, index) => {
      const promptPath = `content/prompts/${task.id}/${index}.txt`;
      if (message.contentRef.relativePath !== promptPath) {
        throw new ProjectError('PROJECT_PATH_INVALID', 'Prompt content path is inconsistent');
      }
      expected.set(message.contentRef.relativePath, message.contentRef);
    });
  }
  for (const version of project.versions) {
    const versionPath = `content/versions/${version.id}.md`;
    if (version.contentRef.relativePath !== versionPath) {
      throw new ProjectError('PROJECT_PATH_INVALID', 'Version content path is inconsistent');
    }
    expected.set(version.contentRef.relativePath, version.contentRef);
  }
  return expected;
};

const expectedImagePaths = (
  project: ProjectAggregateV1,
): Map<string, { ref: ImageArtifactRef; id: string }> => {
  const expected = new Map<string, { ref: ImageArtifactRef; id: string }>();
  for (const image of project.images) {
    const expectedPath = `assets/images/${image.id}.jpg`;
    if (image.ref.relativePath !== expectedPath) {
      throw new ProjectError('PROJECT_PATH_INVALID', 'Image path is inconsistent');
    }
    expected.set(image.ref.relativePath, { ref: image.ref, id: image.id });
  }
  return expected;
};

const contentKind = (ref: TextArtifactRef): 'minutes' | 'promptContent' | 'versionContent' => {
  if (ref.relativePath.startsWith('content/minutes/')) return 'minutes';
  if (ref.relativePath.startsWith('content/prompts/')) return 'promptContent';
  return 'versionContent';
};

const contentEntityId = (project: ProjectAggregateV1, ref: TextArtifactRef): string => {
  if (ref.relativePath === project.minutes.contentRef.relativePath) return project.minutes.minuteId;
  for (const prompt of project.prompts) {
    if (prompt.messages.some((message) => message.contentRef.relativePath === ref.relativePath))
      return prompt.id;
  }
  const version = project.versions.find(
    (candidate) => candidate.contentRef.relativePath === ref.relativePath,
  );
  if (version !== undefined) return version.id;
  throw ProjectError.schemaInvalid('Text artifact owner is missing');
};

export const materializeProjectState = (
  project: ProjectAggregateV1,
  artifactInputs: ArtifactInputs,
): {
  state: ProjectStateIndexV1;
  candidates: CandidateObject[];
  suppliedArtifacts: Map<string, Buffer>;
} => {
  projectAggregateShapeCheck(project);
  for (const report of project.retrievalReports) {
    if (sha256(Buffer.from(report.redactedQueryText, 'utf8')) !== report.querySha256) {
      throw ProjectError.hashMismatch('Retrieval query hash does not match its text');
    }
  }
  const contentRefs = expectedContentPaths(project);
  const imageRefs = expectedImagePaths(project);
  const candidates: CandidateObject[] = [];
  const suppliedArtifacts = new Map<string, Buffer>();
  for (const [relativePath, value] of artifactInputs) {
    const textRef = contentRefs.get(relativePath);
    const imageRef = imageRefs.get(relativePath);
    if (textRef === undefined && imageRef === undefined)
      throw new ProjectError('PROJECT_PATH_INVALID', 'Unexpected artifact path');
    if (textRef !== undefined) {
      const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
      verifyBytes(bytes, textRef.byteLength, textRef.sha256);
      assertNoCredentialMaterial(bytes);
      suppliedArtifacts.set(relativePath, bytes);
      candidates.push({
        bytes,
        ref: storedObjectRefSchema.parse({
          relativePath: textRef.relativePath,
          sha256: textRef.sha256,
          byteLength: textRef.byteLength,
          kind: contentKind(textRef),
          entityId: contentEntityId(project, textRef),
          recordVersion: 1,
        }),
      });
    } else if (imageRef !== undefined) {
      const bytes = Buffer.from(value);
      verifyBytes(bytes, imageRef.ref.byteLength, imageRef.ref.sha256);
      suppliedArtifacts.set(relativePath, bytes);
      candidates.push({
        bytes,
        ref: storedObjectRefSchema.parse({
          relativePath: imageRef.ref.relativePath,
          sha256: imageRef.ref.sha256,
          byteLength: imageRef.ref.byteLength,
          kind: 'image',
          entityId: imageRef.id,
          recordVersion: 1,
        }),
      });
    }
  }

  const minutes = makeRecord('minutes', project.minutes);
  const prompts = project.prompts.map((value) => makeRecord('prompt', value));
  const tasks = project.tasks.map((value) => makeRecord('task', value));
  const versions = project.versions.map((value) => makeRecord('version', value));
  const comments = project.comments.map((value) => makeRecord('comment', value));
  const retrievalReports = project.retrievalReports.map((value) =>
    makeRecord('retrievalReport', value),
  );
  const exportRecords = project.exportRecords.map((value) => makeRecord('exportRecord', value));
  candidates.push(
    minutes,
    ...prompts,
    ...tasks,
    ...versions,
    ...comments,
    ...retrievalReports,
    ...exportRecords,
  );
  candidates.forEach((candidate) => {
    if (candidate.ref.kind !== 'image') assertNoCredentialMaterial(candidate.bytes);
  });
  const imageOrder = new Map(project.images.map((image, index) => [image.ref.relativePath, index]));
  const imageStoredRefs = candidates
    .filter((candidate) => candidate.ref.kind === 'image')
    .toSorted(
      (left, right) =>
        (imageOrder.get(left.ref.relativePath) ?? 0) -
        (imageOrder.get(right.ref.relativePath) ?? 0),
    )
    .map((candidate) => candidate.ref);
  const state: ProjectStateIndexV1 = {
    project: {
      name: project.name,
      profile: project.profile,
      ...(project.profileSnapshot === undefined
        ? {}
        : { profileSnapshot: project.profileSnapshot }),
      status: project.status,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      ...(project.archivedAt === undefined ? {} : { archivedAt: project.archivedAt }),
      createdWith: project.createdWith,
      lastWrittenWith: project.lastWrittenWith,
      projectConfig: project.projectConfig,
    },
    currentMinutes: minutes.ref,
    latestVersionId: project.latestVersionId,
    prompts: prompts.map((value) => value.ref),
    tasks: tasks.map((value) => value.ref),
    versions: versions.map((value) => value.ref),
    comments: comments.map((value) => value.ref),
    retrievalReports: retrievalReports.map((value) => value.ref),
    exportRecords: exportRecords.map((value) => value.ref),
    images: imageStoredRefs,
  };
  assertNoCredentialMaterial(serializeJson(state.project));
  return { state, candidates, suppliedArtifacts };
};

const projectAggregateShapeCheck = (project: ProjectAggregateV1): void => {
  const issues = assertValidProjectAggregate(project);
  void issues;
};

const readObject = async (root: string, ref: StoredObjectRef): Promise<Buffer> => {
  await assertExistingAncestorsHaveNoReparsePoint(root, ref.relativePath);
  const target = resolveProjectPath(root, ref.relativePath);
  if (ref.byteLength > recordMaxBytes) {
    throw ProjectError.schemaInvalid('Project record exceeds the supported size');
  }
  const bytes = await readLimitedFile(target, recordMaxBytes);
  verifyBytes(bytes, ref.byteLength, ref.sha256);
  return bytes;
};

const parseRecord = async (root: string, ref: StoredObjectRef): Promise<DiskRecordV1> => {
  const bytes = await readObject(root, ref);
  assertNoCredentialMaterial(bytes);
  const record = parseJsonBytes(bytes, diskRecordV1Schema, recordMaxBytes);
  if (record.kind !== ref.kind || record.entityId !== ref.entityId) {
    throw ProjectError.schemaInvalid('Record reference does not match payload');
  }
  if (recordPath(record.kind, record.payload) !== ref.relativePath) {
    throw ProjectError.schemaInvalid('Record path does not match payload identity');
  }
  return record;
};

export const hydrateProjectState = async (
  root: string,
  projectId: ProjectAggregateV1['projectId'],
  revision: number,
  state: ProjectStateIndexV1,
): Promise<MaterializedProject> => {
  assertNoCredentialMaterial(serializeJson(state.project));
  const minuteRecord = await parseRecord(root, state.currentMinutes);
  const parseRecords = async (refs: readonly StoredObjectRef[]) =>
    await Promise.all(refs.map(async (ref) => await parseRecord(root, ref)));
  const [
    promptRecords,
    taskRecords,
    versionRecords,
    commentRecords,
    retrievalRecords,
    exportRecords,
  ] = await Promise.all([
    parseRecords(state.prompts),
    parseRecords(state.tasks),
    parseRecords(state.versions),
    parseRecords(state.comments),
    parseRecords(state.retrievalReports),
    parseRecords(state.exportRecords),
  ]);
  const aggregate = {
    format: 'news-writer-project' as const,
    schemaVersion: 1 as const,
    projectId,
    revision,
    ...state.project,
    minutes: minuteRecord.payload,
    latestVersionId: state.latestVersionId,
    prompts: promptRecords.map((record) => record.payload),
    tasks: taskRecords.map((record) => record.payload),
    versions: versionRecords.map((record) => record.payload),
    comments: commentRecords.map((record) => record.payload),
    retrievalReports: retrievalRecords.map((record) => record.payload),
    exportRecords: exportRecords.map((record) => record.payload),
  };
  const parsed = assertValidProjectAggregate(aggregate);
  for (const report of parsed.retrievalReports) {
    if (sha256(Buffer.from(report.redactedQueryText, 'utf8')) !== report.querySha256) {
      throw ProjectError.hashMismatch('Retrieval query hash does not match its text');
    }
  }
  const refs = expectedContentPaths(parsed);
  const textArtifacts = new Map<string, Buffer>();
  for (const ref of refs.values()) {
    await assertExistingAncestorsHaveNoReparsePoint(root, ref.relativePath);
    const bytes = await readLimitedFile(resolveProjectPath(root, ref.relativePath), ref.byteLength);
    verifyBytes(bytes, ref.byteLength, ref.sha256);
    assertNoCredentialMaterial(bytes);
    textArtifacts.set(ref.relativePath, bytes);
  }
  const imageArtifacts = new Map<string, Buffer>();
  for (const image of parsed.images) {
    await assertExistingAncestorsHaveNoReparsePoint(root, image.ref.relativePath);
    const bytes = await readLimitedFile(
      resolveProjectPath(root, image.ref.relativePath),
      image.ref.byteLength,
    );
    verifyBytes(bytes, image.ref.byteLength, image.ref.sha256);
    imageArtifacts.set(image.ref.relativePath, bytes);
  }
  const fullyValidated = assertValidProjectAggregate(parsed, {
    readText: (ref) => textArtifacts.get(ref.relativePath)?.toString('utf8'),
  });
  return { aggregate: fullyValidated, textArtifacts, imageArtifacts };
};
