import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AiSafeError } from './errors';
import { boundedFetch, ERROR_BODY_LIMIT, SUCCESS_BODY_LIMIT } from './transport';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.close();
      await once(server, 'close');
    }),
  );
});

const serve = async (handler: RequestListener): Promise<string> => {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing address');
  return `http://127.0.0.1:${address.port}`;
};

describe('bounded native fetch', () => {
  it('reads chunked whitespace and JSON without treating keep-alive as progress reset', async () => {
    const url = await serve((_request, reply) => {
      reply.writeHead(200, { 'content-type': 'application/json' });
      reply.write('\n\n');
      reply.write('{"ok":');
      reply.end('true}\n');
    });
    let headers = 0;
    const result = await boundedFetch(
      url,
      { method: 'POST', body: '{}' },
      new AbortController().signal,
      () => {
        headers += 1;
      },
    );
    expect(new TextDecoder().decode(result.body)).toBe('\n\n{"ok":true}\n');
    expect(headers).toBe(1);
  });

  it('aborts an oversized successful body', async () => {
    const url = await serve((_request, reply) => {
      reply.writeHead(200, { 'content-type': 'application/json' });
      reply.end(Buffer.alloc(SUCCESS_BODY_LIMIT + 1, 65));
    });
    await expect(
      boundedFetch(url, {}, new AbortController().signal, () => undefined),
    ).rejects.toMatchObject({ safe: { code: 'PROTOCOL_INVALID' } });
  });

  it('applies the smaller error body limit', async () => {
    const url = await serve((_request, reply) => {
      reply.writeHead(400, { 'content-type': 'application/json' });
      reply.end(Buffer.alloc(ERROR_BODY_LIMIT + 1, 65));
    });
    await expect(
      boundedFetch(url, {}, new AbortController().signal, () => undefined),
    ).rejects.toMatchObject({ safe: { code: 'PROTOCOL_INVALID' } });
  });

  it('can cancel while waiting for headers and while reading a chunked body', async () => {
    let releaseHeaders!: () => void;
    const headersBarrier = new Promise<void>((resolve) => {
      releaseHeaders = resolve;
    });
    const headersUrl = await serve((_request, reply) => {
      void headersBarrier.then(() => {
        reply.writeHead(200, { 'content-type': 'application/json' });
        reply.end('{}');
      });
    });
    const headersController = new AbortController();
    const waitingHeaders = boundedFetch(headersUrl, {}, headersController.signal, () => undefined);
    headersController.abort();
    releaseHeaders();
    await expect(waitingHeaders).rejects.toMatchObject({ safe: { code: 'REQUEST_CANCELLED' } });

    let releaseBody!: () => void;
    const bodyBarrier = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const bodyUrl = await serve((_request, reply) => {
      reply.writeHead(200, { 'content-type': 'application/json' });
      reply.write('{"partial":');
      void bodyBarrier.then(() => reply.end('true}'));
    });
    const bodyController = new AbortController();
    let receivedHeaders = false;
    const waitingBody = boundedFetch(bodyUrl, {}, bodyController.signal, () => {
      receivedHeaders = true;
    });
    await vi.waitFor(() => expect(receivedHeaders).toBe(true));
    bodyController.abort();
    releaseBody();
    await expect(waitingBody).rejects.toMatchObject({ safe: { code: 'REQUEST_CANCELLED' } });
  });

  it('maps connection reset and abort without leaking native errors', async () => {
    const resetUrl = await serve((request) => request.socket.destroy());
    await expect(
      boundedFetch(resetUrl, {}, new AbortController().signal, () => undefined),
    ).rejects.toMatchObject({ safe: { code: 'NETWORK_UNAVAILABLE' } });
    const delayedUrl = await serve(() => undefined);
    const controller = new AbortController();
    const pending = boundedFetch(delayedUrl, {}, controller.signal, () => undefined);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AiSafeError);
    await expect(pending).rejects.toMatchObject({ safe: { code: 'REQUEST_CANCELLED' } });
  });
});
