import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { diagnoseProject } from './repository';
import {
  commitManifestV1Schema,
  diskRecordV1Schema,
  projectHeadV1Schema,
  projectStateSnapshotV1Schema,
} from './schemas';
import { parseJsonBytes } from './serialization';

const fixturesRoot = path.resolve(import.meta.dirname, '../../../tests/fixtures/projects');

const listFiles = async (root: string): Promise<string[]> => {
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else result.push(target);
    }
  }
  return result;
};

describe('approved project fixtures', () => {
  it.each(['linear', 'branch', 'corrupt'])(
    'parses every JSON file in %s through a formal disk schema',
    async (name) => {
      const root = path.join(fixturesRoot, name);
      for (const file of await listFiles(root)) {
        if (!file.endsWith('.json')) continue;
        const relative = path.relative(root, file).replaceAll(path.sep, '/');
        const bytes = await readFile(file);
        if (relative === 'project.json') {
          parseJsonBytes(bytes, projectHeadV1Schema, 8 * 1024 * 1024);
        } else if (relative.startsWith('.news-writer/commits/')) {
          parseJsonBytes(bytes, commitManifestV1Schema, 4 * 1024 * 1024);
        } else if (relative.startsWith('.news-writer/snapshots/')) {
          parseJsonBytes(bytes, projectStateSnapshotV1Schema, 8 * 1024 * 1024);
        } else if (relative.startsWith('records/')) {
          parseJsonBytes(bytes, diskRecordV1Schema, 4 * 1024 * 1024);
        } else {
          throw new Error(`Unrouted JSON fixture: ${relative}`);
        }
      }
    },
  );

  it('hydrates the linear and branch fixtures with their intended version relationships', async () => {
    const linearHeadBefore = await readFile(path.join(fixturesRoot, 'linear', 'project.json'));
    const linear = await diagnoseProject(path.join(fixturesRoot, 'linear'));
    expect(linear.versions).toHaveLength(2);
    expect(
      linear.versions.find((version) => version.id === linear.latestVersionId)?.parentVersionId,
    ).toBe(linear.versions.find((version) => version.parentVersionId === null)?.id);
    expect(linear.retrievalReports).toHaveLength(1);
    expect(linear.exportRecords).toHaveLength(1);
    expect(await readFile(path.join(fixturesRoot, 'linear', 'project.json'))).toEqual(
      linearHeadBefore,
    );

    const branch = await diagnoseProject(path.join(fixturesRoot, 'branch'));
    expect(branch.versions).toHaveLength(3);
    const root = branch.versions.find((version) => version.parentVersionId === null);
    expect(branch.versions.filter((version) => version.parentVersionId === root?.id)).toHaveLength(
      2,
    );
    expect(branch.comments).toHaveLength(1);
  });

  it('rejects the intentionally corrupted fixture by content hash', async () => {
    await expect(diagnoseProject(path.join(fixturesRoot, 'corrupt'))).rejects.toMatchObject({
      code: 'PROJECT_HASH_MISMATCH',
    });
  });
});
