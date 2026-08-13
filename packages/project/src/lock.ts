import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';

import { timestampSchema, type Timestamp } from '@news-writer/shared';

import { replaceAtomic } from './atomic.js';
import { ProjectError, mapFileSystemError } from './errors.js';
import {
  instanceIdSchema,
  lockOwnerV1Schema,
  type InstanceId,
  type LockOwnerV1,
} from './schemas.js';
import { parseJsonBytes, serializeJson } from './serialization.js';

const heartbeatIntervalMs = 5_000;
const staleThresholdMs = 30_000;

const nowTimestamp = (): Timestamp => timestampSchema.parse(new Date().toISOString());

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' ? value : undefined;
};

const readOwner = async (lockRoot: string): Promise<LockOwnerV1> => {
  try {
    const bytes = await readFile(path.join(lockRoot, 'owner.json'));
    return parseJsonBytes(bytes, lockOwnerV1Schema, 32 * 1024);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new ProjectError(
        'PROJECT_LOCK_RECOVERY_REQUIRED',
        'The project lock is incomplete and requires explicit recovery',
      );
    }
    throw error instanceof ProjectError ? error : mapFileSystemError(error);
  }
};

const isFresh = (owner: LockOwnerV1): boolean =>
  Date.now() - Date.parse(owner.heartbeatAt) < staleThresholdMs;

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
};

const sameOwner = (left: LockOwnerV1, right: LockOwnerV1): boolean =>
  left.instanceId === right.instanceId &&
  left.pid === right.pid &&
  left.processStartedAt === right.processStartedAt &&
  left.heartbeatAt === right.heartbeatAt;

export class ProjectLock {
  readonly instanceId: InstanceId;
  readonly owner: LockOwnerV1;
  readonly #lockRoot: string;
  #timer: NodeJS.Timeout | undefined;
  #compromised = false;

  private constructor(lockRoot: string, owner: LockOwnerV1) {
    this.#lockRoot = lockRoot;
    this.owner = owner;
    this.instanceId = owner.instanceId;
    this.#timer = setInterval(() => {
      void this.#heartbeat().catch(() => {
        this.#compromised = true;
      });
    }, heartbeatIntervalMs);
    this.#timer.unref();
  }

  static async acquire(storageRoot: string, appVersion: string): Promise<ProjectLock> {
    const lockRoot = path.join(storageRoot, 'write.lock');
    try {
      await mkdir(lockRoot);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw mapFileSystemError(error);
      let current: LockOwnerV1;
      try {
        current = await readOwner(lockRoot);
      } catch {
        throw new ProjectError(
          'PROJECT_LOCK_RECOVERY_REQUIRED',
          'The project lock is incomplete and requires explicit recovery',
        );
      }
      const fresh = isFresh(current);
      throw new ProjectError(
        fresh ? 'PROJECT_LOCKED' : 'PROJECT_LOCK_RECOVERY_REQUIRED',
        fresh
          ? 'The project is already open in another window or process'
          : 'The project lock may be stale and requires explicit recovery',
        {
          retryable: fresh,
          ...(!fresh ? { observedLockInstanceId: current.instanceId } : {}),
        },
      );
    }
    const processStartedAt = timestampSchema.parse(
      new Date(Date.now() - process.uptime() * 1_000).toISOString(),
    );
    const owner = lockOwnerV1Schema.parse({
      format: 'news-writer-lock-owner',
      storageVersion: 1,
      instanceId: instanceIdSchema.parse(randomUUID()),
      pid: process.pid,
      processStartedAt,
      appVersion,
      heartbeatAt: nowTimestamp(),
    });
    try {
      await replaceAtomic(path.join(lockRoot, 'owner.json'), serializeJson(owner));
      return new ProjectLock(lockRoot, owner);
    } catch (error) {
      await rm(lockRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async assertOwned(): Promise<void> {
    if (this.#compromised) {
      throw new ProjectError('PROJECT_LOCK_COMPROMISED', 'The project write lock was lost');
    }
    let owner: LockOwnerV1;
    try {
      owner = await readOwner(this.#lockRoot);
    } catch {
      this.#compromised = true;
      throw new ProjectError('PROJECT_LOCK_COMPROMISED', 'The project write lock is invalid');
    }
    if (owner.instanceId !== this.instanceId || !isFresh(owner)) {
      this.#compromised = true;
      throw new ProjectError(
        'PROJECT_LOCK_COMPROMISED',
        'The project write lock was replaced or its lease expired',
      );
    }
  }

  async #heartbeat(): Promise<void> {
    await this.assertOwned();
    const next = lockOwnerV1Schema.parse({ ...this.owner, heartbeatAt: nowTimestamp() });
    await replaceAtomic(path.join(this.#lockRoot, 'owner.json'), serializeJson(next));
    const current = new Date();
    await utimes(this.#lockRoot, current, current);
  }

  async close(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    if (this.#compromised) return;
    try {
      const owner = await readOwner(this.#lockRoot);
      if (owner.instanceId === this.instanceId) {
        await rm(this.#lockRoot, { recursive: true });
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw mapFileSystemError(error);
    }
  }
}

export const recoverStaleProjectLock = async (
  storageRoot: string,
  observedInstanceId: InstanceId,
  userConfirmed: true,
): Promise<void> => {
  if (!userConfirmed) return;
  const lockRoot = path.join(storageRoot, 'write.lock');
  const owner = await readOwner(lockRoot);
  if (owner.instanceId !== observedInstanceId || isFresh(owner) || isProcessAlive(owner.pid)) {
    throw new ProjectError('PROJECT_LOCKED', 'The project lock is still active', {
      retryable: true,
    });
  }
  const lockStat = await stat(lockRoot);
  if (Date.now() - lockStat.mtimeMs < staleThresholdMs) {
    throw new ProjectError('PROJECT_LOCKED', 'The project lock changed during recovery', {
      retryable: true,
    });
  }
  const confirmedOwner = await readOwner(lockRoot);
  const confirmedStat = await stat(lockRoot);
  if (
    !sameOwner(owner, confirmedOwner) ||
    confirmedStat.dev !== lockStat.dev ||
    confirmedStat.ino !== lockStat.ino ||
    confirmedStat.mtimeMs !== lockStat.mtimeMs ||
    isFresh(confirmedOwner) ||
    isProcessAlive(confirmedOwner.pid)
  ) {
    throw new ProjectError('PROJECT_LOCKED', 'The project lock changed during recovery', {
      retryable: true,
    });
  }
  const quarantine = path.join(
    path.dirname(lockRoot),
    `stale-lock-${owner.instanceId}-${randomUUID()}`,
  );
  try {
    await rename(lockRoot, quarantine);
    const quarantinedOwner = await readOwner(quarantine);
    if (!sameOwner(confirmedOwner, quarantinedOwner)) {
      throw new ProjectError(
        'PROJECT_LOCK_RECOVERY_REQUIRED',
        'The recovered project lock identity is inconsistent',
      );
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'EEXIST') {
      throw new ProjectError('PROJECT_LOCKED', 'Another process recovered the project lock first', {
        retryable: true,
      });
    }
    throw mapFileSystemError(error);
  }
};
