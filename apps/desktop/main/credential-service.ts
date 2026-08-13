import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  safeAppErrorSchema,
  timestampSchema,
  type SafeAppError,
  type Timestamp,
} from '@news-writer/shared';
import { z } from 'zod';

import { readBoundedFile } from './bounded-file-read.js';

const authFileMaxBytes = 16 * 1024;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface CredentialCryptoPort {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface CredentialStatus {
  status: 'notConfigured' | 'configured' | 'unavailable' | 'corrupt';
  provider: 'deepseek';
  updatedAt?: Timestamp;
}

export const authEnvelopeSchema = z
  .object({
    format: z.literal('news-writer-auth'),
    version: z.literal(1),
    provider: z.literal('deepseek'),
    encryptedApiKey: z.string().min(1).max(12_000).regex(base64Pattern),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

const safeError = (
  code: 'AUTH_STORAGE_UNAVAILABLE' | 'AUTH_STORAGE_CORRUPT',
  safeMessage: string,
  causeCode?: string,
): SafeAppError =>
  safeAppErrorSchema.parse({
    code,
    occurredAt: timestampSchema.parse(new Date().toISOString()),
    safeMessage,
    retryable: code === 'AUTH_STORAGE_UNAVAILABLE',
    ...(causeCode === undefined ? {} : { causeCode }),
  });

export class CredentialServiceError extends Error {
  readonly safe: SafeAppError;

  constructor(safe: SafeAppError) {
    super(safe.safeMessage);
    this.name = 'CredentialServiceError';
    this.safe = safe;
  }
}

const allowlistedCause = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' &&
    ['EACCES', 'EBUSY', 'EDQUOT', 'EEXIST', 'ENOENT', 'ENOSPC', 'EPERM', 'EROFS', 'EXDEV'].includes(
      code,
    )
    ? code
    : undefined;
};

const isMissing = (error: unknown): boolean => allowlistedCause(error) === 'ENOENT';

export class CredentialService {
  readonly #authPath: string;
  readonly #crypto: CredentialCryptoPort;

  constructor(userData: string, crypto: CredentialCryptoPort) {
    this.#authPath = path.join(userData, 'auth.json');
    this.#crypto = crypto;
  }

  async getStatus(): Promise<CredentialStatus> {
    if (!this.#crypto.isEncryptionAvailable()) {
      return { status: 'unavailable', provider: 'deepseek' };
    }
    try {
      const envelope = await this.#readEnvelope();
      if (envelope === undefined) return { status: 'notConfigured', provider: 'deepseek' };
      this.#decrypt(envelope.encryptedApiKey);
      return { status: 'configured', provider: 'deepseek', updatedAt: envelope.updatedAt };
    } catch (error) {
      if (error instanceof CredentialServiceError && error.safe.code === 'AUTH_STORAGE_CORRUPT') {
        return { status: 'corrupt', provider: 'deepseek' };
      }
      return { status: 'unavailable', provider: 'deepseek' };
    }
  }

  async setDeepSeekApiKey(apiKey: string): Promise<CredentialStatus> {
    if (apiKey.trim().length === 0 || apiKey.length > 4096) {
      throw new CredentialServiceError(
        safeError('AUTH_STORAGE_CORRUPT', 'The API credential format is invalid'),
      );
    }
    if (!this.#crypto.isEncryptionAvailable()) {
      throw new CredentialServiceError(
        safeError('AUTH_STORAGE_UNAVAILABLE', 'Secure credential storage is unavailable'),
      );
    }
    let encryptedApiKey: string;
    try {
      encryptedApiKey = this.#crypto.encryptString(apiKey).toString('base64');
    } catch {
      throw new CredentialServiceError(
        safeError('AUTH_STORAGE_UNAVAILABLE', 'Secure credential storage is unavailable'),
      );
    }
    const existing = await this.#readEnvelope().catch(() => undefined);
    const now = timestampSchema.parse(new Date().toISOString());
    const envelope = authEnvelopeSchema.parse({
      format: 'news-writer-auth',
      version: 1,
      provider: 'deepseek',
      encryptedApiKey,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await this.#atomicWrite(`${JSON.stringify(envelope)}\n`);
    return { status: 'configured', provider: 'deepseek', updatedAt: now };
  }

  async clearDeepSeekApiKey(confirmed: true): Promise<CredentialStatus> {
    if (confirmed !== true) {
      throw new CredentialServiceError(
        safeError('AUTH_STORAGE_CORRUPT', 'Credential removal requires confirmation'),
      );
    }
    try {
      await rm(this.#authPath, { force: true });
    } catch (error) {
      throw new CredentialServiceError(
        safeError(
          'AUTH_STORAGE_UNAVAILABLE',
          'The credential could not be removed',
          allowlistedCause(error),
        ),
      );
    }
    return { status: 'notConfigured', provider: 'deepseek' };
  }

  async readApiKey(): Promise<string> {
    if (!this.#crypto.isEncryptionAvailable()) {
      throw new CredentialServiceError(
        safeError('AUTH_STORAGE_UNAVAILABLE', 'Secure credential storage is unavailable'),
      );
    }
    const envelope = await this.#readEnvelope();
    if (envelope === undefined) {
      throw new CredentialServiceError(
        safeAppErrorSchema.parse({
          code: 'AUTH_REQUIRED',
          occurredAt: timestampSchema.parse(new Date().toISOString()),
          safeMessage: 'Configure a DeepSeek API credential before starting a task',
          retryable: false,
        }),
      );
    }
    return this.#decrypt(envelope.encryptedApiKey);
  }

  async readConfiguredApiKey(): Promise<string | undefined> {
    if (!this.#crypto.isEncryptionAvailable()) return undefined;
    const envelope = await this.#readEnvelope();
    return envelope === undefined ? undefined : this.#decrypt(envelope.encryptedApiKey);
  }

  async #readEnvelope(): Promise<z.infer<typeof authEnvelopeSchema> | undefined> {
    try {
      const bytes = await readBoundedFile(this.#authPath, authFileMaxBytes);
      return authEnvelopeSchema.parse(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw new CredentialServiceError(
        safeError('AUTH_STORAGE_CORRUPT', 'Stored credentials are unreadable'),
      );
    }
  }

  #decrypt(value: string): string {
    try {
      const bytes = Buffer.from(value, 'base64');
      if (bytes.length === 0 || bytes.toString('base64') !== value) throw new Error('bad base64');
      const decrypted = this.#crypto.decryptString(bytes);
      if (decrypted.trim().length === 0 || decrypted.length > 4096) throw new Error('bad key');
      return decrypted;
    } catch {
      throw new CredentialServiceError(
        safeError('AUTH_STORAGE_CORRUPT', 'Stored credentials are unreadable'),
      );
    }
  }

  async #atomicWrite(content: string): Promise<void> {
    const directory = path.dirname(this.#authPath);
    const temporaryPath = path.join(directory, `.auth-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.#authPath);
      const directoryHandle = await open(directory, 'r');
      await directoryHandle.sync().catch(() => undefined);
      await directoryHandle.close();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new CredentialServiceError(
        safeError(
          'AUTH_STORAGE_UNAVAILABLE',
          'The credential could not be saved',
          allowlistedCause(error),
        ),
      );
    }
  }
}
