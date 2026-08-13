import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ExportFileError, publishDocxAtomic } from './document-publish.js';

const roots: string[] = [];
const root = async () => {
  const value = await mkdtemp(path.join(tmpdir(), 'news-writer-export-'));
  roots.push(value);
  return value;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (value) => await rm(value, { recursive: true, force: true })),
  );
});

describe('atomic DOCX publishing', () => {
  it('publishes and verifies a new file', async () => {
    const directory = await root();
    const target = path.join(directory, '中文新闻稿.docx');
    const bytes = new Uint8Array([80, 75, 3, 4, 1, 2, 3]);
    const result = await publishDocxAtomic(target, bytes);
    expect(new Uint8Array(await readFile(target))).toEqual(bytes);
    expect(result.byteLength).toBe(bytes.byteLength);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('atomically replaces a user-confirmed existing target', async () => {
    const directory = await root();
    const target = path.join(directory, 'existing.docx');
    await writeFile(target, 'old');
    await publishDocxAtomic(target, new TextEncoder().encode('replacement'));
    expect(await readFile(target, 'utf8')).toBe('replacement');
  });

  it('rejects non-DOCX paths without changing an existing file', async () => {
    const directory = await root();
    const target = path.join(directory, 'existing.txt');
    await writeFile(target, 'old');
    await expect(
      publishDocxAtomic(target, new TextEncoder().encode('replacement')),
    ).rejects.toBeInstanceOf(ExportFileError);
    expect(await readFile(target, 'utf8')).toBe('old');
  });

  it('rejects a vanished directory', async () => {
    const directory = await root();
    await rm(directory, { recursive: true });
    await expect(
      publishDocxAtomic(path.join(directory, 'news.docx'), new Uint8Array([1])),
    ).rejects.toMatchObject({ code: 'EXPORT_PATH_INVALID' });
  });
});
