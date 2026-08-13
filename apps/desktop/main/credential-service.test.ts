import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CredentialService,
  CredentialServiceError,
  type CredentialCryptoPort,
} from './credential-service.js';

const roots: string[] = [];
const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nw-auth-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

const fakeCrypto = (available = true): CredentialCryptoPort => ({
  isEncryptionAvailable: () => available,
  encryptString: (value) => Buffer.from(`cipher:${value}`, 'utf8'),
  decryptString: (value) => {
    const text = value.toString('utf8');
    if (!text.startsWith('cipher:')) throw new Error('decrypt failed');
    return text.slice(7);
  },
});

describe('CredentialService', () => {
  it('persists only ciphertext and returns no credential details', async () => {
    const root = await makeRoot();
    const service = new CredentialService(root, fakeCrypto());
    const status = await service.setDeepSeekApiKey('unit-test-credential-value');
    expect(status.status).toBe('configured');
    expect(await service.readApiKey()).toBe('unit-test-credential-value');
    expect(await service.readConfiguredApiKey()).toBe('unit-test-credential-value');
    const disk = await readFile(path.join(root, 'auth.json'), 'utf8');
    expect(disk).not.toContain('unit-test-credential-value');
    expect(JSON.parse(disk)).toEqual(
      expect.objectContaining({ format: 'news-writer-auth', version: 1, provider: 'deepseek' }),
    );
    expect(await service.getStatus()).toEqual(status);
  });

  it('does not fall back when encryption is unavailable', async () => {
    const root = await makeRoot();
    const service = new CredentialService(root, fakeCrypto(false));
    await expect(service.setDeepSeekApiKey('unit-test-credential-value')).rejects.toMatchObject({
      safe: { code: 'AUTH_STORAGE_UNAVAILABLE' },
    });
    expect(await service.getStatus()).toEqual({ status: 'unavailable', provider: 'deepseek' });
    expect(await service.readConfiguredApiKey()).toBeUndefined();
  });

  it('preserves corrupt storage until an explicit overwrite or clear', async () => {
    const root = await makeRoot();
    const target = path.join(root, 'auth.json');
    await writeFile(target, '{"format":"news-writer-auth"', 'utf8');
    const service = new CredentialService(root, fakeCrypto());
    expect(await service.getStatus()).toEqual({ status: 'corrupt', provider: 'deepseek' });
    expect(await readFile(target, 'utf8')).toBe('{"format":"news-writer-auth"');
    await service.setDeepSeekApiKey('replacement-credential-value');
    expect(await service.readApiKey()).toBe('replacement-credential-value');
    await service.clearDeepSeekApiKey(true);
    expect(await service.getStatus()).toEqual({ status: 'notConfigured', provider: 'deepseek' });
  });

  it('rejects empty, overlong and invalid ciphertext values', async () => {
    const root = await makeRoot();
    const service = new CredentialService(root, fakeCrypto());
    await expect(service.setDeepSeekApiKey('  ')).rejects.toBeInstanceOf(CredentialServiceError);
    await expect(service.setDeepSeekApiKey('x'.repeat(4097))).rejects.toBeInstanceOf(
      CredentialServiceError,
    );
    await writeFile(
      path.join(root, 'auth.json'),
      JSON.stringify({
        format: 'news-writer-auth',
        version: 1,
        provider: 'deepseek',
        encryptedApiKey: 'not base64!',
        createdAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:00.000Z',
      }),
      'utf8',
    );
    await expect(service.readApiKey()).rejects.toMatchObject({
      safe: { code: 'AUTH_STORAGE_CORRUPT' },
    });
  });

  it('rejects auth files over 16 KiB with a fixed safe error', async () => {
    const root = await makeRoot();
    const target = path.join(root, 'auth.json');
    const privateContent = 'private-auth-content';
    await writeFile(target, privateContent.repeat(1024), 'utf8');
    const service = new CredentialService(root, fakeCrypto());

    let error: unknown;
    try {
      await service.readApiKey();
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      safe: {
        code: 'AUTH_STORAGE_CORRUPT',
        safeMessage: 'Stored credentials are unreadable',
      },
    });
    if (!(error instanceof CredentialServiceError)) throw new Error('expected credential error');
    expect(JSON.stringify(error.safe)).not.toContain(target);
    expect(JSON.stringify(error.safe)).not.toContain(privateContent);
  });
});
