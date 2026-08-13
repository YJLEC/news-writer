import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { DOCUMENT_MAX_OUTPUT_BYTES } from '@news-writer/documents';

const delays = [25, 50, 100, 200, 400, 800, 1_000] as const;
const retryable = new Set(['EACCES', 'EPERM', 'EBUSY']);
const codeOf = (error: unknown): string | undefined =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
const wait = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

export class ExportFileError extends Error {
  constructor(
    readonly code:
      | 'EXPORT_PATH_INVALID'
      | 'EXPORT_NOT_WRITABLE'
      | 'EXPORT_DISK_FULL'
      | 'EXPORT_ATOMIC_REPLACE_FAILED'
      | 'EXPORT_IO_ERROR',
    readonly causeCode?: string,
  ) {
    super(code);
  }
}

const mapped = (error: unknown): ExportFileError => {
  const code = codeOf(error);
  if (code === 'ENOSPC' || code === 'EDQUOT') return new ExportFileError('EXPORT_DISK_FULL', code);
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
    return new ExportFileError('EXPORT_NOT_WRITABLE', code);
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EINVAL')
    return new ExportFileError('EXPORT_PATH_INVALID', code);
  return new ExportFileError('EXPORT_IO_ERROR', code);
};

export const publishDocxAtomic = async (
  target: string,
  bytes: Uint8Array,
): Promise<{ sha256: string; byteLength: number }> => {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > DOCUMENT_MAX_OUTPUT_BYTES ||
    path.extname(target).toLowerCase() !== '.docx'
  )
    throw new ExportFileError('EXPORT_PATH_INVALID');
  const directory = path.dirname(path.resolve(target));
  try {
    if (!(await lstat(directory)).isDirectory()) throw new ExportFileError('EXPORT_PATH_INVALID');
  } catch (error) {
    if (error instanceof ExportFileError) throw error;
    throw mapped(error);
  }
  const temp = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp, 'wx');
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temp, target);
        break;
      } catch (error) {
        const code = codeOf(error);
        const delay = delays[attempt];
        if (!retryable.has(code ?? '') || delay === undefined) {
          if (retryable.has(code ?? ''))
            throw new ExportFileError('EXPORT_ATOMIC_REPLACE_FAILED', code);
          throw mapped(error);
        }
        await wait(delay);
      }
    }
    const published = await readFile(target);
    const expected = createHash('sha256').update(bytes).digest('hex');
    const actual = createHash('sha256').update(published).digest('hex');
    if (published.byteLength !== bytes.byteLength || actual !== expected)
      throw new ExportFileError('EXPORT_IO_ERROR');
    return { sha256: expected, byteLength: bytes.byteLength };
  } catch (error) {
    if (error instanceof ExportFileError) throw error;
    throw mapped(error);
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
  }
};
