import { describe, expect, it } from 'vitest';

import { projectRelativePathSchema, sha256Schema } from '@news-writer/shared';

import { mapFileSystemError } from './errors';
import { getMigrationPath, migrationRegistry } from './migrations';
import { resolveProjectPath } from './paths';
import { commitManifestV1Schema, prepareManifestV1Schema } from './schemas';
import { parseJsonBytes, serializeJson } from './serialization';

const uuid = (value: number): string =>
  `20000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

const hash = sha256Schema.parse('a'.repeat(64));

const genesis = {
  format: 'news-writer-commit',
  storageVersion: 1,
  schemaVersion: 1,
  projectId: uuid(1),
  commitId: uuid(2),
  parentCommitId: null,
  parentCommitHash: null,
  transactionId: uuid(3),
  operation: 'genesis',
  baseRevision: null,
  revision: 0,
  createdAt: '2026-08-09T03:00:00.000Z',
  snapshot: {
    relativePath: `.news-writer/snapshots/0-${uuid(2)}.json`,
    sha256: hash,
    byteLength: 100,
    kind: 'snapshot',
    entityId: uuid(2),
    recordVersion: 1,
  },
  writes: [],
  details: { operation: 'genesis' },
};

describe('project disk schemas', () => {
  it('accepts the explicit genesis convention and rejects chain ambiguity', () => {
    expect(commitManifestV1Schema.parse(genesis).revision).toBe(0);
    expect(commitManifestV1Schema.safeParse({ ...genesis, revision: 1 }).success).toBe(false);
    expect(commitManifestV1Schema.safeParse({ ...genesis, extra: true }).success).toBe(false);
  });

  it('requires complete-task transaction identities to agree', () => {
    const commit = {
      ...genesis,
      commitId: uuid(4),
      parentCommitId: uuid(2),
      parentCommitHash: hash,
      transactionId: uuid(5),
      operation: 'completeTaskWithVersion',
      baseRevision: 0,
      revision: 1,
      snapshot: {
        ...genesis.snapshot,
        relativePath: `.news-writer/snapshots/1-${uuid(4)}.json`,
        entityId: uuid(4),
      },
      details: {
        operation: 'completeTaskWithVersion',
        successTransactionId: uuid(6),
        taskId: uuid(7),
        fromTaskSequence: 4,
        toTaskSequence: 5,
        versionId: uuid(8),
        baseRevision: 0,
        revision: 1,
      },
    };
    expect(commitManifestV1Schema.safeParse(commit).success).toBe(false);
    expect(
      commitManifestV1Schema.safeParse({
        ...commit,
        details: { ...commit.details, successTransactionId: uuid(5) },
      }).success,
    ).toBe(true);
    expect(
      commitManifestV1Schema.safeParse({
        ...commit,
        details: {
          ...commit.details,
          successTransactionId: uuid(5),
          toTaskSequence: 6,
        },
      }).success,
    ).toBe(false);
    expect(
      commitManifestV1Schema.safeParse({
        ...commit,
        baseRevision: null,
        details: { ...commit.details, successTransactionId: uuid(5) },
      }).success,
    ).toBe(false);
    expect(
      prepareManifestV1Schema.safeParse({
        ...commit,
        format: 'news-writer-prepare',
        details: { ...commit.details, successTransactionId: uuid(5) },
      }).success,
    ).toBe(true);
  });

  it('requires UTF-8 JSON with LF and a single trailing newline', () => {
    const bytes = serializeJson(genesis);
    expect(parseJsonBytes(bytes, commitManifestV1Schema, 100_000)).toBeTruthy();
    expect(() =>
      parseJsonBytes(Buffer.from(JSON.stringify(genesis)), commitManifestV1Schema, 100_000),
    ).toThrow();
    expect(() =>
      parseJsonBytes(Buffer.concat([bytes, Buffer.from('\n')]), commitManifestV1Schema, 100_000),
    ).toThrow();
    expect(() =>
      parseJsonBytes(
        Buffer.from(bytes.toString('utf8').replaceAll('\n', '\r\n')),
        commitManifestV1Schema,
        100_000,
      ),
    ).toThrow();
  });

  it('keeps the V1 migration registry empty and requires linear unique steps', () => {
    expect(migrationRegistry).toEqual([]);
    expect(getMigrationPath(1, 1)).toEqual([]);
    expect(() => getMigrationPath(1, 2)).toThrow();
    expect(() =>
      getMigrationPath(1, 2, [
        { from: 1, to: 2, migrate: (value) => value },
        { from: 1, to: 2, migrate: (value) => value },
      ]),
    ).toThrow();
    const syntheticRegistry = [
      { from: 1, to: 2, migrate: (value: { steps: number[] }) => ({ steps: [...value.steps, 2] }) },
      { from: 2, to: 3, migrate: (value: { steps: number[] }) => ({ steps: [...value.steps, 3] }) },
    ];
    const path = getMigrationPath(1, 3, syntheticRegistry);
    const migrated = path.reduce<{ steps: number[] }>(
      (value, migration) => migration.migrate(value) as { steps: number[] },
      { steps: [1] },
    );
    expect(migrated).toEqual({ steps: [1, 2, 3] });
  });

  it('maps filesystem errors without exposing their path or message', () => {
    const mapped = mapFileSystemError(
      Object.assign(new Error('C:\\Users\\private\\secret'), { code: 'ENOSPC' }),
    );
    expect(mapped.code).toBe('PROJECT_DISK_FULL');
    expect(mapped.message).not.toContain('private');
    expect(mapped.toSafeError()).not.toHaveProperty('stack');
  });

  it('resolves only validated paths within the root', () => {
    const root = 'C:\\safe\\project';
    expect(
      resolveProjectPath(root, projectRelativePathSchema.parse('records/tasks/a.json')),
    ).toContain('records');
    expect(() => resolveProjectPath(root, '../escape' as never)).toThrow();
  });
});
