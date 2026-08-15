import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { assertValidProjectAggregate, type ProjectAggregateV1 } from '@news-writer/domain';
import {
  containsSecretMaterial,
  projectRelativePathSchema,
  timestampSchema,
} from '@news-writer/shared';

import {
  probeFileSystemCapabilities,
  publishImmutable,
  readLimitedFile,
  replaceAtomic,
} from './atomic.js';
import { ProjectError, mapFileSystemError } from './errors.js';
import { hitCommitBarrier } from './faults.js';
import {
  type ArtifactInputs,
  type CandidateObject,
  hydrateProjectState,
  materializeProjectState,
  type MaterializedProject,
} from './layout.js';
import { ProjectLock, recoverStaleProjectLock } from './lock.js';
import {
  assertPathHasNoReparsePoint,
  assertExistingAncestorsHaveNoReparsePoint,
  canonicalizeNewProjectTarget,
  canonicalizeProjectRoot,
  projectSessionKey,
  resolveProjectPath,
} from './paths.js';
import {
  commitDetailsSchema,
  commitIdSchema,
  commitManifestV1Schema,
  instanceIdSchema,
  prepareManifestV1Schema,
  projectHeadV1Schema,
  projectStateSnapshotV1Schema,
  storageEnvelopeProbeSchema,
  storedObjectRefSchema,
  transactionIdSchema,
  type CommitId,
  type CommitManifestV1,
  type ProjectHeadV1,
  type ProjectStateSnapshotV1,
  type PrepareManifestV1,
  type TransactionId,
  type StoredObjectRef,
} from './schemas.js';
import { parseJsonBytes, serializeJson, sha256, verifyBytes } from './serialization.js';

const headMaxBytes = 8 * 1024 * 1024;
const manifestMaxBytes = 4 * 1024 * 1024;
const snapshotMaxBytes = 8 * 1024 * 1024;
const recordMaxBytes = 4 * 1024 * 1024;
const storedObjectMaxBytes = 64 * 1024 * 1024;

const activeSessions = new Map<string, ProjectSession>();
const rootQueues = new Map<string, Promise<void>>();

const enqueue = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
  const previous = rootQueues.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  rootQueues.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (rootQueues.get(key) === current) rootQueues.delete(key);
  }
};

const headPath = (root: string): string => path.join(root, 'project.json');
const storageRoot = (root: string): string => path.join(root, '.news-writer');

const commitRelativePath = (revision: number, commitId: CommitId) =>
  projectRelativePathSchema.parse(`.news-writer/commits/${revision}-${commitId}.json`);

const snapshotRelativePath = (revision: number, commitId: CommitId) =>
  projectRelativePathSchema.parse(`.news-writer/snapshots/${revision}-${commitId}.json`);

const readHead = async (root: string): Promise<ProjectHeadV1> => {
  await assertExistingAncestorsHaveNoReparsePoint(
    root,
    projectRelativePathSchema.parse('project.json'),
  );
  const bytes = await readLimitedFile(headPath(root), headMaxBytes);
  let probe;
  try {
    probe = storageEnvelopeProbeSchema.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw ProjectError.schemaInvalid('Project head schema is invalid');
  }
  if (probe.storageVersion > 1 || probe.schemaVersion > 1) {
    throw new ProjectError('PROJECT_SCHEMA_TOO_NEW', 'This project requires a newer app version');
  }
  return parseJsonBytes(bytes, projectHeadV1Schema, headMaxBytes);
};

interface ReadCommit {
  manifest: CommitManifestV1;
  hash: ReturnType<typeof sha256>;
  bytes: Buffer;
}

const readCommit = async (
  root: string,
  revision: number,
  commitId: CommitId,
): Promise<ReadCommit> => {
  const relativePath = commitRelativePath(revision, commitId);
  await assertExistingAncestorsHaveNoReparsePoint(root, relativePath);
  const target = resolveProjectPath(root, relativePath);
  const bytes = await readLimitedFile(target, manifestMaxBytes);
  return {
    manifest: parseJsonBytes(bytes, commitManifestV1Schema, manifestMaxBytes),
    hash: sha256(bytes),
    bytes,
  };
};

const readSnapshot = async (
  root: string,
  ref: StoredObjectRef,
): Promise<ProjectStateSnapshotV1> => {
  await assertExistingAncestorsHaveNoReparsePoint(root, ref.relativePath);
  const bytes = await readLimitedFile(resolveProjectPath(root, ref.relativePath), snapshotMaxBytes);
  verifyBytes(bytes, ref.byteLength, ref.sha256);
  return parseJsonBytes(bytes, projectStateSnapshotV1Schema, snapshotMaxBytes);
};

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const verifyCommitWrites = async (root: string, commit: CommitManifestV1): Promise<void> => {
  for (const write of commit.writes) {
    const maxBytes = write.relativePath.startsWith('records/')
      ? recordMaxBytes
      : storedObjectMaxBytes;
    if (write.byteLength > maxBytes) {
      throw ProjectError.schemaInvalid('A committed project object exceeds the supported size');
    }
    await assertExistingAncestorsHaveNoReparsePoint(root, write.relativePath);
    const bytes = await readLimitedFile(resolveProjectPath(root, write.relativePath), maxBytes);
    verifyBytes(bytes, write.byteLength, write.sha256);
  }
};

const verifyCommitChain = async (
  root: string,
  head: ProjectHeadV1,
): Promise<{ current: ReadCommit; chainFiles: Set<string>; chain: ReadCommit[] }> => {
  let revision = head.revision;
  let commitId: CommitId | null = head.headCommitId;
  let expectedHash: ReturnType<typeof sha256> | null = head.headCommitHash;
  let current: ReadCommit | undefined;
  const chain: ReadCommit[] = [];
  const chainFiles = new Set<string>();
  while (commitId !== null && expectedHash !== null) {
    chainFiles.add(`${revision}-${commitId}.json`);
    const read = await readCommit(root, revision, commitId);
    if (
      read.hash !== expectedHash ||
      read.manifest.commitId !== commitId ||
      read.manifest.revision !== revision
    ) {
      throw ProjectError.hashMismatch('Project commit chain is invalid');
    }
    await verifyCommitWrites(root, read.manifest);
    chain.push(read);
    current ??= read;
    if (read.manifest.operation === 'genesis') {
      if (revision !== 0) throw ProjectError.schemaInvalid('Genesis revision is invalid');
      commitId = null;
      expectedHash = null;
    } else {
      if (
        read.manifest.baseRevision === null ||
        read.manifest.parentCommitId === null ||
        read.manifest.parentCommitHash === null
      ) {
        throw ProjectError.schemaInvalid('Project commit parent is missing');
      }
      revision = read.manifest.baseRevision;
      commitId = read.manifest.parentCommitId;
      expectedHash = read.manifest.parentCommitHash;
    }
  }
  if (current === undefined) throw ProjectError.schemaInvalid('Project commit chain is empty');
  return { current, chainFiles, chain };
};

const canonicalStateRefs = (
  materialized: MaterializedProject,
  state: ProjectStateSnapshotV1['state'],
): StoredObjectRef[] => {
  const refs: StoredObjectRef[] = [
    state.currentMinutes,
    ...state.prompts,
    ...state.tasks,
    ...state.versions,
    ...state.comments,
    ...state.retrievalReports,
    ...state.exportRecords,
  ];
  const project = materialized.aggregate;
  const textObjectRef = (
    ref: ProjectAggregateV1['minutes']['contentRef'],
    kind: 'minutes' | 'promptContent' | 'versionContent',
    entityId: string,
  ): StoredObjectRef =>
    storedObjectRefSchema.parse({
      relativePath: ref.relativePath,
      sha256: ref.sha256,
      byteLength: ref.byteLength,
      kind,
      entityId,
      recordVersion: 1,
    });
  refs.push(textObjectRef(project.minutes.contentRef, 'minutes', project.minutes.minuteId));
  for (const prompt of project.prompts) {
    for (const message of prompt.messages) {
      refs.push(textObjectRef(message.contentRef, 'promptContent', prompt.id));
    }
  }
  for (const version of project.versions) {
    refs.push(textObjectRef(version.contentRef, 'versionContent', version.id));
  }
  for (const image of project.images) {
    refs.push(
      storedObjectRefSchema.parse({
        relativePath: image.ref.relativePath,
        sha256: image.ref.sha256,
        byteLength: image.ref.byteLength,
        kind: 'image',
        entityId: image.id,
        recordVersion: 1,
      }),
    );
  }
  return refs;
};

const writeProjection = (ref: StoredObjectRef) => ({
  relativePath: ref.relativePath,
  sha256: ref.sha256,
  byteLength: ref.byteLength,
  kind: ref.kind,
  entityId: ref.entityId,
  recordVersion: ref.recordVersion,
});

const validateCommitTransition = async (
  root: string,
  commit: ReadCommit,
  snapshot: ProjectStateSnapshotV1,
  parent: MaterializedProject | null,
): Promise<MaterializedProject> => {
  if (
    snapshot.projectId !== commit.manifest.projectId ||
    snapshot.commitId !== commit.manifest.commitId ||
    snapshot.revision !== commit.manifest.revision
  ) {
    throw ProjectError.schemaInvalid('Commit snapshot identity is inconsistent');
  }
  const materialized = await hydrateProjectState(
    root,
    snapshot.projectId,
    snapshot.revision,
    snapshot.state,
  );
  const canonicalState = materializeProjectState(materialized.aggregate, new Map()).state;
  if (!sameJson(canonicalState, snapshot.state)) {
    throw ProjectError.schemaInvalid('Commit snapshot references are not canonical');
  }
  const parentRefs = new Map(
    (parent === null
      ? []
      : canonicalStateRefs(parent, materializeProjectState(parent.aggregate, new Map()).state)
    ).map((ref) => [ref.relativePath, ref.sha256]),
  );
  const expectedWrites = canonicalStateRefs(materialized, canonicalState)
    .filter((ref) => parentRefs.get(ref.relativePath) !== ref.sha256)
    .map(writeProjection)
    .toSorted((left, right) => left.relativePath.localeCompare(right.relativePath));
  const actualWrites = commit.manifest.writes.toSorted((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  if (!sameJson(actualWrites, expectedWrites)) {
    throw ProjectError.schemaInvalid('Commit writes do not match the snapshot delta');
  }

  if (
    commit.manifest.operation === 'completeTaskWithVersion' &&
    commit.manifest.details.operation === 'completeTaskWithVersion'
  ) {
    if (parent === null) throw ProjectError.schemaInvalid('Completed task commit has no parent');
    const details = commit.manifest.details;
    const before = parent.aggregate.tasks.find((task) => task.id === details.taskId);
    const after = materialized.aggregate.tasks.find((task) => task.id === details.taskId);
    const version = materialized.aggregate.versions.find(
      (candidate) => candidate.id === details.versionId,
    );
    if (
      before?.status !== 'saving' ||
      before.sequence !== details.fromTaskSequence ||
      before.successTransactionId !== details.successTransactionId ||
      before.proposedVersionId !== details.versionId ||
      after?.status !== 'succeeded' ||
      after.sequence !== details.toTaskSequence ||
      after.successTransactionId !== details.successTransactionId ||
      after.resultVersionId !== details.versionId ||
      after.committedRevision !== details.revision ||
      version?.taskId !== details.taskId ||
      materialized.aggregate.latestVersionId !== details.versionId ||
      parent.aggregate.versions.some((candidate) => candidate.id === details.versionId) ||
      materialized.aggregate.versions.length !== parent.aggregate.versions.length + 1
    ) {
      throw ProjectError.schemaInvalid('Completed task commit details do not match its snapshots');
    }
  }
  return materialized;
};

const validateHead = async (root: string, head: ProjectHeadV1): Promise<MaterializedProject> => {
  const { current: commit, chain } = await verifyCommitChain(root, head);
  if (commit.hash !== head.headCommitHash || !sameJson(commit.manifest.snapshot, head.snapshot)) {
    throw ProjectError.schemaInvalid('Project head and commit are inconsistent');
  }
  const snapshot = await readSnapshot(root, head.snapshot);
  if (
    snapshot.projectId !== head.projectId ||
    snapshot.revision !== head.revision ||
    snapshot.commitId !== head.headCommitId ||
    !sameJson(snapshot.state, head.state)
  ) {
    throw ProjectError.schemaInvalid('Project head and snapshot are inconsistent');
  }
  let materialized: MaterializedProject | null = null;
  for (const chainCommit of chain.toReversed()) {
    const chainSnapshot = await readSnapshot(root, chainCommit.manifest.snapshot);
    materialized = await validateCommitTransition(root, chainCommit, chainSnapshot, materialized);
  }
  if (materialized === null) throw ProjectError.schemaInvalid('Project commit history is empty');
  return materialized;
};

interface Successor {
  commit: ReadCommit;
  snapshot: ProjectStateSnapshotV1;
  materialized: MaterializedProject;
}

const findDirectSuccessors = async (
  root: string,
  head: ProjectHeadV1,
  parent: MaterializedProject,
): Promise<Successor[]> => {
  const commitsRoot = path.join(storageRoot(root), 'commits');
  const names = await readdir(commitsRoot);
  const { chainFiles } = await verifyCommitChain(root, head);
  const successors: Successor[] = [];
  for (const name of names) {
    const match = /^(\d+)-([0-9a-f-]{36})\.json$/.exec(name);
    if (match === null) continue;
    const revision = Number(match[1]);
    const idText = match[2];
    if (!Number.isSafeInteger(revision) || idText === undefined) continue;
    if (chainFiles.has(name)) continue;
    const id = commitIdSchema.parse(idText);
    const commit = await readCommit(root, revision, id);
    if (
      commit.manifest.parentCommitId === head.headCommitId &&
      commit.manifest.parentCommitHash === head.headCommitHash &&
      commit.manifest.baseRevision === head.revision &&
      commit.manifest.revision === head.revision + 1
    ) {
      const snapshot = await readSnapshot(root, commit.manifest.snapshot);
      if (
        snapshot.projectId !== head.projectId ||
        snapshot.commitId !== commit.manifest.commitId ||
        snapshot.revision !== commit.manifest.revision
      ) {
        throw ProjectError.schemaInvalid('Successor snapshot is inconsistent');
      }
      await verifyCommitWrites(root, commit.manifest);
      const materialized = await validateCommitTransition(root, commit, snapshot, parent);
      successors.push({ commit, snapshot, materialized });
    } else {
      throw new ProjectError(
        'PROJECT_RECOVERY_AMBIGUOUS',
        'A committed project manifest does not form a unique continuous chain',
      );
    }
  }
  return successors;
};

const headFromSuccessor = (successor: Successor): ProjectHeadV1 =>
  projectHeadV1Schema.parse({
    format: 'news-writer-project',
    storageVersion: 1,
    schemaVersion: 1,
    projectId: successor.snapshot.projectId,
    revision: successor.snapshot.revision,
    headCommitId: successor.commit.manifest.commitId,
    headCommitHash: successor.commit.hash,
    snapshot: successor.commit.manifest.snapshot,
    state: successor.snapshot.state,
  });

const loadProject = async (
  root: string,
  recover: boolean,
): Promise<{ head: ProjectHeadV1; materialized: MaterializedProject }> => {
  let head = await readHead(root);
  let materialized = await validateHead(root, head);
  if (!recover) return { head, materialized };

  while (true) {
    const successors = await findDirectSuccessors(root, head, materialized);
    if (successors.length === 0) return { head, materialized };
    if (successors.length > 1) {
      throw new ProjectError(
        'PROJECT_RECOVERY_AMBIGUOUS',
        'The project has multiple valid successor commits',
      );
    }
    const successor = successors[0];
    if (successor === undefined) return { head, materialized };
    const nextHead = headFromSuccessor(successor);
    materialized = successor.materialized;
    await replaceAtomic(headPath(root), serializeJson(nextHead));
    head = nextHead;
  }
};

const existingCommitByTransaction = async (
  root: string,
  transactionId: TransactionId,
): Promise<ReadCommit | undefined> => {
  const names = await readdir(path.join(storageRoot(root), 'commits'));
  const matches: ReadCommit[] = [];
  for (const name of names) {
    const match = /^(\d+)-([0-9a-f-]{36})\.json$/.exec(name);
    if (match === null || match[1] === undefined || match[2] === undefined) continue;
    const commit = await readCommit(root, Number(match[1]), commitIdSchema.parse(match[2]));
    if (commit.manifest.transactionId === transactionId) matches.push(commit);
  }
  if (matches.length > 1) {
    throw new ProjectError(
      'PROJECT_RECOVERY_AMBIGUOUS',
      'A transaction ID appears in multiple commits',
    );
  }
  return matches[0];
};

const ensureCandidateAvailability = async (
  root: string,
  candidates: readonly CandidateObject[],
  expectedPrepare: PrepareManifestV1,
): Promise<CandidateObject[]> => {
  const unique = new Map<string, CandidateObject>();
  for (const candidate of candidates) {
    const prior = unique.get(candidate.ref.relativePath);
    if (prior !== undefined && prior.ref.sha256 !== candidate.ref.sha256) {
      throw new ProjectError('PROJECT_CONFLICT', 'Two project objects target the same path');
    }
    unique.set(candidate.ref.relativePath, candidate);
  }
  const preparePath = projectRelativePathSchema.parse(
    `.news-writer/staging/${expectedPrepare.transactionId}/prepare.json`,
  );
  let priorPrepare: PrepareManifestV1 | undefined;
  try {
    await assertExistingAncestorsHaveNoReparsePoint(root, preparePath);
    const bytes = await readLimitedFile(resolveProjectPath(root, preparePath), manifestMaxBytes);
    priorPrepare = parseJsonBytes(bytes, prepareManifestV1Schema, manifestMaxBytes);
    if (!sameJson(priorPrepare, expectedPrepare)) {
      throw new ProjectError(
        'PROJECT_CONFLICT',
        'The transaction staging data belongs to a different commit request',
      );
    }
  } catch (error) {
    if (!(error instanceof ProjectError && error.code === 'PROJECT_NOT_FOUND')) throw error;
  }
  const newCandidates: CandidateObject[] = [];
  for (const candidate of unique.values()) {
    const target = resolveProjectPath(root, candidate.ref.relativePath);
    try {
      await assertExistingAncestorsHaveNoReparsePoint(root, candidate.ref.relativePath);
      const bytes = await readLimitedFile(target, candidate.ref.byteLength);
      verifyBytes(bytes, candidate.ref.byteLength, candidate.ref.sha256);
      if (priorPrepare === undefined) {
        throw new ProjectError(
          'PROJECT_CONFLICT',
          'An immutable project object belongs to another transaction',
        );
      }
    } catch (error) {
      if (error instanceof ProjectError && error.code === 'PROJECT_NOT_FOUND') {
        newCandidates.push(candidate);
      } else {
        throw error;
      }
    }
  }
  return newCandidates;
};

const stagingPathFor = (transactionId: TransactionId, target: StoredObjectRef) =>
  projectRelativePathSchema.parse(
    `.news-writer/staging/${transactionId}/payloads/${target.relativePath}`,
  );

interface WriteCommitInput {
  aggregate: ProjectAggregateV1;
  artifacts: ArtifactInputs;
  transactionId: TransactionId;
  commitId: CommitId;
  operation: CommitManifestV1['operation'];
  details: CommitManifestV1['details'];
  parentHead: ProjectHeadV1 | null;
  parentMaterialized: MaterializedProject | null;
}

const referencedObjectHashes = (materialized: MaterializedProject | null): Map<string, string> => {
  const result = new Map<string, string>();
  if (materialized === null) return result;
  const parentState = materializeProjectState(materialized.aggregate, new Map());
  parentState.candidates.forEach((candidate) =>
    result.set(candidate.ref.relativePath, candidate.ref.sha256),
  );
  const textRefs = [
    materialized.aggregate.minutes.contentRef,
    ...materialized.aggregate.prompts.flatMap((prompt) =>
      prompt.messages.map((message) => message.contentRef),
    ),
    ...materialized.aggregate.versions.map((version) => version.contentRef),
  ];
  textRefs.forEach((ref) => result.set(ref.relativePath, ref.sha256));
  materialized.aggregate.images.forEach((image) =>
    result.set(image.ref.relativePath, image.ref.sha256),
  );
  return result;
};

const writeCommit = async (root: string, input: WriteCommitInput): Promise<ProjectHeadV1> => {
  const materialized = materializeProjectState(input.aggregate, input.artifacts);
  const combinedArtifacts = new Map<string, Buffer>(materialized.suppliedArtifacts);
  const contentRefs = [
    input.aggregate.minutes.contentRef,
    ...input.aggregate.prompts.flatMap((prompt) =>
      prompt.messages.map((message) => message.contentRef),
    ),
    ...input.aggregate.versions.map((version) => version.contentRef),
  ];
  for (const ref of contentRefs) {
    if (!combinedArtifacts.has(ref.relativePath)) {
      try {
        const bytes = await readFile(resolveProjectPath(root, ref.relativePath));
        verifyBytes(bytes, ref.byteLength, ref.sha256);
        combinedArtifacts.set(ref.relativePath, bytes);
      } catch (error) {
        throw error instanceof ProjectError
          ? error
          : new ProjectError('PROJECT_HASH_MISMATCH', 'A referenced text artifact is missing');
      }
    }
  }
  const imageRefs = input.aggregate.images.map((image) => image.ref);
  for (const ref of imageRefs) {
    if (!combinedArtifacts.has(ref.relativePath)) {
      try {
        const bytes = await readFile(resolveProjectPath(root, ref.relativePath));
        verifyBytes(bytes, ref.byteLength, ref.sha256);
        combinedArtifacts.set(ref.relativePath, bytes);
      } catch (error) {
        throw error instanceof ProjectError
          ? error
          : new ProjectError('PROJECT_HASH_MISMATCH', 'A referenced image artifact is missing');
      }
    }
  }
  for (const [relativePath, bytes] of combinedArtifacts) {
    if (input.aggregate.images.some((image) => image.ref.relativePath === relativePath)) continue;
    if (containsSecretMaterial([bytes.toString('utf8')])) {
      throw ProjectError.schemaInvalid('Credential material cannot be stored in a project');
    }
  }
  assertValidProjectAggregate(input.aggregate, {
    readText: (ref) => combinedArtifacts.get(ref.relativePath)?.toString('utf8'),
  });

  const parentHashes = referencedObjectHashes(input.parentMaterialized);
  const writeCandidates = materialized.candidates.filter((candidate) => {
    const parentHash = parentHashes.get(candidate.ref.relativePath);
    if (parentHash === undefined) return true;
    if (parentHash !== candidate.ref.sha256) {
      throw new ProjectError('PROJECT_CONFLICT', 'An immutable project object changed in place');
    }
    return false;
  });
  const snapshot = projectStateSnapshotV1Schema.parse({
    format: 'news-writer-state-snapshot',
    storageVersion: 1,
    schemaVersion: 1,
    projectId: input.aggregate.projectId,
    revision: input.aggregate.revision,
    commitId: input.commitId,
    state: materialized.state,
  });
  const snapshotBytes = serializeJson(snapshot);
  const snapshotRef = storedObjectRefSchema.parse({
    relativePath: snapshotRelativePath(input.aggregate.revision, input.commitId),
    sha256: sha256(snapshotBytes),
    byteLength: snapshotBytes.byteLength,
    kind: 'snapshot',
    entityId: input.commitId,
    recordVersion: 1,
  });
  const prepare = prepareManifestV1Schema.parse({
    format: 'news-writer-prepare',
    storageVersion: 1,
    schemaVersion: 1,
    projectId: input.aggregate.projectId,
    commitId: input.commitId,
    parentCommitId: input.parentHead?.headCommitId ?? null,
    parentCommitHash: input.parentHead?.headCommitHash ?? null,
    transactionId: input.transactionId,
    operation: input.operation,
    baseRevision: input.parentHead?.revision ?? null,
    revision: input.aggregate.revision,
    createdAt: input.aggregate.updatedAt,
    snapshot: snapshotRef,
    writes: writeCandidates.map((candidate) => ({
      ...candidate.ref,
      kind: candidate.ref.kind === 'snapshot' ? 'versionContent' : candidate.ref.kind,
      stagingPath: stagingPathFor(input.transactionId, candidate.ref),
    })),
    details: input.details,
  });
  await ensureCandidateAvailability(root, writeCandidates, prepare);
  const stagingRoot = path.join(storageRoot(root), 'staging', input.transactionId);
  try {
    await mkdir(stagingRoot, { recursive: false });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'EEXIST'
    ) {
      const quarantine = path.join(
        storageRoot(root),
        'staging',
        `quarantine-${input.transactionId}-${randomUUID()}`,
      );
      await rename(stagingRoot, quarantine);
      await mkdir(stagingRoot);
    } else {
      throw mapFileSystemError(error);
    }
  }

  for (const candidate of writeCandidates) {
    await assertExistingAncestorsHaveNoReparsePoint(root, candidate.ref.relativePath);
    await publishImmutable(
      resolveProjectPath(root, stagingPathFor(input.transactionId, candidate.ref)),
      candidate.bytes,
      candidate.ref.sha256,
    );
  }
  await publishImmutable(
    path.join(stagingRoot, 'snapshot.json'),
    snapshotBytes,
    snapshotRef.sha256,
  );
  await hitCommitBarrier('afterStagingPayloads');

  await publishImmutable(path.join(stagingRoot, 'prepare.json'), serializeJson(prepare));
  await hitCommitBarrier('afterPrepare');

  for (const candidate of writeCandidates) {
    await publishImmutable(
      resolveProjectPath(root, candidate.ref.relativePath),
      candidate.bytes,
      candidate.ref.sha256,
    );
  }
  await hitCommitBarrier('afterPayloadPublish');
  await publishImmutable(
    resolveProjectPath(root, snapshotRef.relativePath),
    snapshotBytes,
    snapshotRef.sha256,
  );
  await hitCommitBarrier('afterSnapshotPublish');

  const commit = commitManifestV1Schema.parse({
    format: 'news-writer-commit',
    storageVersion: 1,
    schemaVersion: 1,
    projectId: input.aggregate.projectId,
    commitId: input.commitId,
    parentCommitId: input.parentHead?.headCommitId ?? null,
    parentCommitHash: input.parentHead?.headCommitHash ?? null,
    transactionId: input.transactionId,
    operation: input.operation,
    baseRevision: input.parentHead?.revision ?? null,
    revision: input.aggregate.revision,
    createdAt: input.aggregate.updatedAt,
    snapshot: snapshotRef,
    writes: writeCandidates.map((candidate) => ({
      ...candidate.ref,
      kind: candidate.ref.kind === 'snapshot' ? 'versionContent' : candidate.ref.kind,
    })),
    details: input.details,
  });
  const commitBytes = serializeJson(commit);
  const commitHash = sha256(commitBytes);
  await publishImmutable(
    resolveProjectPath(root, commitRelativePath(input.aggregate.revision, input.commitId)),
    commitBytes,
    commitHash,
  );
  try {
    await hitCommitBarrier('afterCommitPublish');
    const head = projectHeadV1Schema.parse({
      format: 'news-writer-project',
      storageVersion: 1,
      schemaVersion: 1,
      projectId: input.aggregate.projectId,
      revision: input.aggregate.revision,
      headCommitId: input.commitId,
      headCommitHash: commitHash,
      snapshot: snapshotRef,
      state: materialized.state,
    });
    await replaceAtomic(headPath(root), serializeJson(head));
    await hitCommitBarrier('afterHeadReplace');
    const verifiedHead = await readHead(root);
    if (
      verifiedHead.headCommitId !== input.commitId ||
      verifiedHead.headCommitHash !== commitHash ||
      verifiedHead.revision !== input.aggregate.revision
    ) {
      throw new ProjectError(
        'PROJECT_RECOVERY_REQUIRED',
        'The committed project head requires recovery',
        {
          retryable: true,
          transactionId: input.transactionId,
        },
      );
    }
    await rm(stagingRoot, { recursive: true, force: true });
    return head;
  } catch (error) {
    if (error instanceof ProjectError && error.code === 'PROJECT_RECOVERY_REQUIRED') {
      throw error;
    }
    throw new ProjectError(
      'PROJECT_RECOVERY_REQUIRED',
      'The project commit succeeded but the project head requires recovery',
      {
        retryable: true,
        transactionId: input.transactionId,
        suggestedAction: 'Reopen the project to complete recovery',
      },
    );
  }
};

export interface CommitProjectInput {
  transactionId: string;
  commitId: string;
  expectedRevision: number;
  expectedHeadCommitId: string;
  operation?: 'update' | 'completeTaskWithVersion' | 'migration';
  details?: unknown;
  nextAggregate: ProjectAggregateV1;
  artifacts?: ArtifactInputs;
}

export class ProjectSession {
  readonly root: string;
  readonly #key: string;
  readonly #lock: ProjectLock;
  #head: ProjectHeadV1;
  #materialized: MaterializedProject;
  #references = 1;
  #closed = false;

  constructor(
    root: string,
    key: string,
    lock: ProjectLock,
    head: ProjectHeadV1,
    materialized: MaterializedProject,
  ) {
    this.root = root;
    this.#key = key;
    this.#lock = lock;
    this.#head = head;
    this.#materialized = materialized;
  }

  retain(): ProjectSession {
    if (this.#closed)
      throw new ProjectError('PROJECT_LOCK_COMPROMISED', 'Project session is closed');
    this.#references += 1;
    return this;
  }

  read(): ProjectAggregateV1 {
    if (this.#closed)
      throw new ProjectError('PROJECT_LOCK_COMPROMISED', 'Project session is closed');
    return structuredClone(this.#materialized.aggregate);
  }

  readText(ref: ProjectAggregateV1['minutes']['contentRef']): string {
    if (this.#closed)
      throw new ProjectError('PROJECT_LOCK_COMPROMISED', 'Project session is closed');
    const aggregate = this.#materialized.aggregate;
    const authoritative = [
      aggregate.minutes.contentRef,
      ...aggregate.prompts.flatMap((prompt) =>
        prompt.messages.map((message) => message.contentRef),
      ),
      ...aggregate.versions.map((version) => version.contentRef),
    ].find((candidate) => candidate.relativePath === ref.relativePath);
    if (
      authoritative === undefined ||
      authoritative.sha256 !== ref.sha256 ||
      authoritative.byteLength !== ref.byteLength ||
      authoritative.mediaType !== ref.mediaType ||
      authoritative.encoding !== ref.encoding
    ) {
      throw new ProjectError('PROJECT_PATH_INVALID', 'Text artifact is not owned by this project');
    }
    const value = this.#materialized.textArtifacts.get(ref.relativePath);
    if (value === undefined)
      throw new ProjectError('PROJECT_HASH_MISMATCH', 'Project text content is missing');
    verifyBytes(value, ref.byteLength, ref.sha256);
    return value.toString('utf8');
  }

  get headCommitId(): CommitId {
    return this.#head.headCommitId;
  }

  async refresh(): Promise<ProjectAggregateV1> {
    if (this.#closed)
      throw new ProjectError('PROJECT_LOCK_COMPROMISED', 'Project session is closed');
    return await enqueue(this.#key, async () => {
      await this.#lock.assertOwned();
      const authoritative = await loadProject(this.root, true);
      this.#head = authoritative.head;
      this.#materialized = authoritative.materialized;
      return this.read();
    });
  }

  async commit(input: CommitProjectInput): Promise<ProjectAggregateV1> {
    if (this.#closed)
      throw new ProjectError('PROJECT_LOCK_COMPROMISED', 'Project session is closed');
    return await enqueue(this.#key, async () => {
      await this.#lock.assertOwned();
      const authoritative = await loadProject(this.root, true);
      this.#head = authoritative.head;
      this.#materialized = authoritative.materialized;
      const transactionId = transactionIdSchema.parse(input.transactionId);
      const commitId = commitIdSchema.parse(input.commitId);
      const operation = input.operation ?? 'update';
      const details = commitDetailsSchema.parse(input.details ?? { operation });
      if (details.operation !== operation) {
        throw ProjectError.schemaInvalid('Commit details do not match the operation');
      }
      const existing = await existingCommitByTransaction(this.root, transactionId);
      if (existing !== undefined) {
        if (
          existing.manifest.commitId !== commitId ||
          existing.manifest.operation !== operation ||
          existing.manifest.baseRevision !== input.expectedRevision ||
          existing.manifest.parentCommitId !== commitIdSchema.parse(input.expectedHeadCommitId) ||
          !sameJson(existing.manifest.details, details)
        ) {
          throw new ProjectError(
            'PROJECT_CONFLICT',
            'The transaction ID was already used for a different commit request',
          );
        }
        const snapshot = await readSnapshot(this.root, existing.manifest.snapshot);
        const original = await hydrateProjectState(
          this.root,
          snapshot.projectId,
          snapshot.revision,
          snapshot.state,
        );
        if (!sameJson(original.aggregate, input.nextAggregate)) {
          throw new ProjectError(
            'PROJECT_CONFLICT',
            'The transaction retry does not match its original project state',
          );
        }
        return structuredClone(original.aggregate);
      }
      if (
        this.#head.revision !== input.expectedRevision ||
        this.#head.headCommitId !== commitIdSchema.parse(input.expectedHeadCommitId)
      ) {
        throw new ProjectError('PROJECT_CONFLICT', 'The project changed before it could be saved');
      }
      if (input.nextAggregate.revision !== input.expectedRevision + 1) {
        throw new ProjectError('PROJECT_CONFLICT', 'The next project revision is invalid');
      }
      this.#head = await writeCommit(this.root, {
        aggregate: input.nextAggregate,
        artifacts: input.artifacts ?? new Map(),
        transactionId,
        commitId,
        operation,
        details,
        parentHead: this.#head,
        parentMaterialized: this.#materialized,
      });
      this.#materialized = await validateHead(this.root, this.#head);
      return this.read();
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#references -= 1;
    if (this.#references > 0) return;
    this.#closed = true;
    activeSessions.delete(this.#key);
    await this.#lock.close();
  }
}

export interface OpenProjectInput {
  root: string;
  appVersion: string;
}

export const openProject = async (input: OpenProjectInput): Promise<ProjectSession> => {
  const root = await canonicalizeProjectRoot(input.root);
  const key = projectSessionKey(root);
  const existing = activeSessions.get(key);
  if (existing !== undefined) return existing.retain();
  await assertPathHasNoReparsePoint(root, projectRelativePathSchema.parse('.news-writer'));
  await assertPathHasNoReparsePoint(root, projectRelativePathSchema.parse('content'));
  await assertPathHasNoReparsePoint(root, projectRelativePathSchema.parse('records'));
  await assertPathHasNoReparsePoint(root, projectRelativePathSchema.parse('assets'));
  const lock = await ProjectLock.acquire(storageRoot(root), input.appVersion);
  try {
    await probeFileSystemCapabilities(storageRoot(root));
    const loaded = await loadProject(root, true);
    const session = new ProjectSession(root, key, lock, loaded.head, loaded.materialized);
    activeSessions.set(key, session);
    return session;
  } catch (error) {
    await lock.close().catch(() => undefined);
    throw error;
  }
};

export interface CreateProjectOnDiskInput extends OpenProjectInput {
  aggregate: ProjectAggregateV1;
  artifacts: ArtifactInputs;
  transactionId?: string;
  commitId?: string;
}

export const createProjectOnDisk = async (
  input: CreateProjectOnDiskInput,
): Promise<ProjectSession> => {
  if (input.aggregate.revision !== 0) {
    throw new ProjectError('PROJECT_CONFLICT', 'A new project must start at revision zero');
  }
  const target = await canonicalizeNewProjectTarget(input.root);
  try {
    await lstat(target);
    throw new ProjectError('PROJECT_ALREADY_EXISTS', 'The project directory already exists');
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      (error as { code?: unknown }).code !== 'ENOENT'
    ) {
      throw mapFileSystemError(error);
    }
  }
  const temporaryRoot = path.join(
    path.dirname(target),
    `.${path.basename(target)}.creating-${randomUUID()}`,
  );
  await mkdir(path.join(temporaryRoot, '.news-writer', 'commits'), { recursive: true });
  await mkdir(path.join(temporaryRoot, '.news-writer', 'snapshots'), { recursive: true });
  await mkdir(path.join(temporaryRoot, '.news-writer', 'staging'), { recursive: true });
  try {
    await probeFileSystemCapabilities(path.join(temporaryRoot, '.news-writer'));
    await writeCommit(temporaryRoot, {
      aggregate: assertValidProjectAggregate(input.aggregate, {
        readText: (ref) => {
          const value = input.artifacts.get(ref.relativePath);
          if (value === undefined) return undefined;
          return typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
        },
      }),
      artifacts: input.artifacts,
      transactionId: transactionIdSchema.parse(input.transactionId ?? randomUUID()),
      commitId: commitIdSchema.parse(input.commitId ?? randomUUID()),
      operation: 'genesis',
      details: { operation: 'genesis' },
      parentHead: null,
      parentMaterialized: null,
    });
    await rename(temporaryRoot, target);
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return await openProject({ root: target, appVersion: input.appVersion });
};

export const diagnoseProject = async (rootInput: string): Promise<ProjectAggregateV1> => {
  const root = await canonicalizeProjectRoot(rootInput);
  const loaded = await loadProject(root, false);
  return structuredClone(loaded.materialized.aggregate);
};

export const recoverProjectLock = async (
  rootInput: string,
  observedInstanceId: string,
  userConfirmed: true,
): Promise<void> => {
  const root = await canonicalizeProjectRoot(rootInput);
  await recoverStaleProjectLock(
    storageRoot(root),
    instanceIdSchema.parse(observedInstanceId),
    userConfirmed,
  );
};

export const makeTransactionId = (): TransactionId => transactionIdSchema.parse(randomUUID());
export const makeCommitId = (): CommitId => commitIdSchema.parse(randomUUID());
export const nowForProject = () => timestampSchema.parse(new Date().toISOString());
