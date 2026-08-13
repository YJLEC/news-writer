import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { type Sha256 } from '@news-writer/shared';

import { ProjectError, mapFileSystemError } from './errors.js';
import { sha256, verifyBytes } from './serialization.js';

const replaceRetryDelays = [25, 50, 100, 200, 400, 800, 1_000] as const;
const retryableReplaceCodes = new Set(['EACCES', 'EPERM', 'EBUSY']);

const systemCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

const delay = async (milliseconds: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, milliseconds));

const writeSiblingTemp = async (target: string, bytes: Uint8Array): Promise<string> => {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp, 'wx');
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    return temp;
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw mapFileSystemError(error);
  }
};

export const readLimitedFile = async (target: string, maxBytes: number): Promise<Buffer> => {
  try {
    const fileStat = await stat(target);
    if (!fileStat.isFile() || fileStat.size > maxBytes) {
      throw ProjectError.schemaInvalid('Project object type or size is invalid');
    }
    return await readFile(target);
  } catch (error) {
    throw mapFileSystemError(error);
  }
};

export const publishImmutable = async (
  target: string,
  bytes: Uint8Array,
  expectedHash: Sha256 = sha256(bytes),
): Promise<void> => {
  let existing: Buffer | undefined;
  try {
    existing = await readFile(target);
  } catch (error) {
    if (systemCode(error) !== 'ENOENT') throw mapFileSystemError(error);
  }
  if (existing !== undefined) {
    if (sha256(existing) === expectedHash && existing.byteLength === bytes.byteLength) return;
    throw new ProjectError('PROJECT_CONFLICT', 'An immutable project object already exists');
  }
  const temp = await writeSiblingTemp(target, bytes);
  try {
    await rename(temp, target);
    const published = await readFile(target);
    verifyBytes(published, bytes.byteLength, expectedHash);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    if (systemCode(error) === 'EEXIST') {
      throw new ProjectError('PROJECT_CONFLICT', 'An immutable project object already exists');
    }
    throw mapFileSystemError(error);
  }
};

export const replaceAtomic = async (target: string, bytes: Uint8Array): Promise<void> => {
  const temp = await writeSiblingTemp(target, bytes);
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temp, target);
        break;
      } catch (error) {
        const code = systemCode(error);
        const retryDelay = replaceRetryDelays[attempt];
        if (code === undefined || !retryableReplaceCodes.has(code) || retryDelay === undefined) {
          if (retryableReplaceCodes.has(code ?? '')) {
            throw new ProjectError(
              'PROJECT_ATOMIC_REPLACE_FAILED',
              'The project head could not be replaced because another program is using it',
              { retryable: true, ...(code === undefined ? {} : { causeCode: code }) },
            );
          }
          throw mapFileSystemError(error);
        }
        await delay(retryDelay);
      }
    }
    const published = await readFile(target);
    verifyBytes(published, bytes.byteLength, sha256(bytes));
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
};

export const probeFileSystemCapabilities = async (storageRoot: string): Promise<void> => {
  const probeRoot = path.join(storageRoot, `capability-${randomUUID()}`);
  const first = path.join(probeRoot, 'first');
  const second = path.join(probeRoot, 'second');
  try {
    await mkdir(probeRoot);
    const firstHandle = await open(first, 'wx');
    await firstHandle.writeFile(Buffer.from('old\n', 'utf8'));
    await firstHandle.sync();
    await firstHandle.close();
    const secondHandle = await open(second, 'wx');
    await secondHandle.writeFile(Buffer.from('replacement\n', 'utf8'));
    await secondHandle.sync();
    await secondHandle.close();
    await rename(second, first);
    const bytes = await readFile(first);
    if (bytes.toString('utf8') !== 'replacement\n') {
      throw new ProjectError(
        'PROJECT_FILESYSTEM_UNSUPPORTED',
        'The project directory does not preserve required file semantics',
      );
    }
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    const code = systemCode(error);
    throw new ProjectError(
      'PROJECT_FILESYSTEM_UNSUPPORTED',
      'The project directory does not support required atomic operations',
      { ...(code === undefined ? {} : { causeCode: code }) },
    );
  } finally {
    await rm(probeRoot, { recursive: true, force: true }).catch(() => undefined);
  }
};
