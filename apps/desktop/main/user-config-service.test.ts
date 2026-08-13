import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { UserConfigService } from './user-config-service.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

const setup = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nw-user-config-'));
  roots.push(root);
  return { root, service: new UserConfigService(root) };
};

describe('UserConfigService', () => {
  it('atomically stores only strict non-sensitive generation overrides', async () => {
    const { service } = await setup();
    await expect(service.get()).resolves.toEqual({ revision: 0, config: {} });
    await expect(service.update(0, { maxWords: 800, reasoningEffort: 'high' })).resolves.toEqual({
      revision: 1,
      config: { maxWords: 800, reasoningEffort: 'high' },
    });
    await expect(service.get()).resolves.toEqual({
      revision: 1,
      config: { maxWords: 800, reasoningEffort: 'high' },
    });
    await expect(service.update(0, {})).rejects.toMatchObject({
      safe: { code: 'PROJECT_CONFLICT' },
    });
    await expect(service.update(1, { apiKey: 'must-not-be-stored' } as never)).rejects.toThrow();
  });

  it('fails closed when the settings envelope is corrupt', async () => {
    const { root, service } = await setup();
    await writeFile(path.join(root, 'config.json'), '{"apiKey":"secret"}\n', 'utf8');
    await expect(service.get()).rejects.toMatchObject({
      safe: { code: 'CONFIG_STORAGE_CORRUPT' },
    });
  });
});
