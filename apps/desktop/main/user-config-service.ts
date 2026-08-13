import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  generationConfigOverridesSchema,
  type GenerationConfigOverrides,
} from '@news-writer/domain';
import { safeAppErrorSchema, timestampSchema, type SafeAppError } from '@news-writer/shared';
import { z } from 'zod';

const maximumBytes = 16 * 1024;

const envelopeSchema = z
  .object({
    format: z.literal('news-writer-user-config'),
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    config: generationConfigOverridesSchema,
    updatedAt: timestampSchema,
  })
  .strict();

type Envelope = z.infer<typeof envelopeSchema>;

const safe = (
  code: 'CONFIG_STORAGE_UNAVAILABLE' | 'CONFIG_STORAGE_CORRUPT' | 'PROJECT_CONFLICT',
  message: string,
): SafeAppError =>
  safeAppErrorSchema.parse({
    code,
    occurredAt: timestampSchema.parse(new Date().toISOString()),
    safeMessage: message,
    retryable: code === 'CONFIG_STORAGE_UNAVAILABLE' || code === 'PROJECT_CONFLICT',
  });

export class UserConfigServiceError extends Error {
  readonly safe: SafeAppError;

  constructor(error: SafeAppError) {
    super(error.safeMessage);
    this.name = 'UserConfigServiceError';
    this.safe = error;
  }
}

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

export interface UserConfigView {
  revision: number;
  config: GenerationConfigOverrides;
}

export class UserConfigService {
  readonly #filePath: string;

  constructor(userData: string) {
    this.#filePath = path.join(userData, 'config.json');
  }

  async get(): Promise<UserConfigView> {
    const envelope = await this.#read();
    return envelope === undefined
      ? { revision: 0, config: {} }
      : { revision: envelope.revision, config: envelope.config };
  }

  async update(
    expectedRevision: number,
    config: GenerationConfigOverrides,
  ): Promise<UserConfigView> {
    const current = await this.#read();
    const revision = current?.revision ?? 0;
    if (revision !== expectedRevision) {
      throw new UserConfigServiceError(
        safe('PROJECT_CONFLICT', 'User settings changed before the operation'),
      );
    }
    const parsed = generationConfigOverridesSchema.parse(config);
    if (JSON.stringify(parsed) === JSON.stringify(current?.config ?? {})) {
      return { revision, config: parsed };
    }
    const next = envelopeSchema.parse({
      format: 'news-writer-user-config',
      version: 1,
      revision: revision + 1,
      config: parsed,
      updatedAt: timestampSchema.parse(new Date().toISOString()),
    });
    await this.#atomicWrite(`${JSON.stringify(next)}\n`);
    return { revision: next.revision, config: next.config };
  }

  async #read(): Promise<Envelope | undefined> {
    try {
      const bytes = await readFile(this.#filePath);
      if (bytes.byteLength > maximumBytes) throw new Error('oversized');
      return envelopeSchema.parse(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw new UserConfigServiceError(
        safe('CONFIG_STORAGE_CORRUPT', 'Stored user settings are unreadable'),
      );
    }
  }

  async #atomicWrite(content: string): Promise<void> {
    const directory = path.dirname(this.#filePath);
    const temporaryPath = path.join(directory, `.config-${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await mkdir(directory, { recursive: true });
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.#filePath);
      const directoryHandle = await open(directory, 'r');
      await directoryHandle.sync().catch(() => undefined);
      await directoryHandle.close();
    } catch {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new UserConfigServiceError(
        safe('CONFIG_STORAGE_UNAVAILABLE', 'User settings could not be saved'),
      );
    }
  }
}
