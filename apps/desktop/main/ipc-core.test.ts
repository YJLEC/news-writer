import { IPC_CHANNELS, IPC_INVOKE_CONTRACTS } from '@news-writer/shared/ipc';
import { describe, expect, it, vi } from 'vitest';

import { executeIpcRequest } from './ipc-core.js';

const contract = IPC_INVOKE_CONTRACTS[IPC_CHANNELS.runtimeGetInfo];
const runtime = {
  appVersion: '0.1.0',
  electronVersion: '43.3.0',
  chromiumVersion: '150.0.0',
  projectSchemaVersion: 1 as const,
  knowledgeVersion: null,
  profileId: null,
  profileVersion: null,
  platform: 'win32' as const,
  arch: 'x64' as const,
};

describe('IPC handler core', () => {
  it('rejects the sender before parsing or invoking a handler', async () => {
    const handler = vi.fn(async () => runtime);
    const response = await executeIpcRequest(
      contract,
      false,
      handler,
      Object.create({ inherited: true }) as unknown,
      1,
    );
    expect(response).toMatchObject({ ok: false, error: { code: 'IPC_SENDER_REJECTED' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('maps invalid requests and invalid business responses to the protocol error', async () => {
    const invalidRequest = await executeIpcRequest(
      contract,
      true,
      async () => runtime,
      { unknown: true },
      1,
    );
    expect(invalidRequest).toMatchObject({ ok: false, error: { code: 'IPC_PROTOCOL_INVALID' } });
    const invalidResponse = await executeIpcRequest(
      contract,
      true,
      async () => ({ absolutePath: 'C:/private/data' }),
      {},
      1,
    );
    expect(invalidResponse).toMatchObject({ ok: false, error: { code: 'IPC_PROTOCOL_INVALID' } });
    expect(JSON.stringify(invalidResponse)).not.toContain('C:/private');
  });

  it('never propagates raw exception messages or stacks through the envelope', async () => {
    const response = await executeIpcRequest(
      contract,
      true,
      async () => {
        throw new Error('secret raw message <redacted-private-path>');
      },
      {},
      1,
    );
    expect(response).toMatchObject({
      protocolVersion: 1,
      ok: false,
      error: { code: 'UNKNOWN', safeMessage: 'The operation could not be completed' },
    });
    expect(JSON.stringify(response)).not.toMatch(/secret raw|redacted-private|stack/i);
  });

  it('returns only a schema-validated success envelope', async () => {
    await expect(executeIpcRequest(contract, true, async () => runtime, {}, 7)).resolves.toEqual({
      protocolVersion: 1,
      ok: true,
      data: runtime,
    });
  });
});
