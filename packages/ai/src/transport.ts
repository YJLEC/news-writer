import { AiSafeError, makeSafeError, throwSafe } from './errors.js';

export const SUCCESS_BODY_LIMIT = 8 * 1024 * 1024;
export const ERROR_BODY_LIMIT = 64 * 1024;

export interface TransportResponse {
  status: number;
  contentType: string | null;
  retryAfter: string | null;
  body: Uint8Array;
}

export interface JsonTransport {
  post(
    body: string,
    apiKey: string,
    signal: AbortSignal,
    onHeaders: () => void,
  ): Promise<TransportResponse>;
}

const readBounded = async (
  response: Response,
  limit: number,
  controller: AbortController,
): Promise<Uint8Array> => {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) {
        controller.abort();
        throwSafe('PROTOCOL_INVALID', 'The AI service response exceeded the allowed size');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
};

export const boundedFetch = async (
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  onHeaders: () => void,
): Promise<TransportResponse> => {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
    if (response.ok) onHeaders();
    const body = await readBounded(
      response,
      response.ok ? SUCCESS_BODY_LIMIT : ERROR_BODY_LIMIT,
      controller,
    );
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      retryAfter: response.headers.get('retry-after'),
      body,
    };
  } catch (error) {
    if (error instanceof AiSafeError) throw error;
    if (controller.signal.aborted) {
      throw new AiSafeError(
        makeSafeError('REQUEST_CANCELLED', 'The request was cancelled', { retryable: true }),
      );
    }
    throw new AiSafeError(
      makeSafeError('NETWORK_UNAVAILABLE', 'The AI service could not be reached', {
        retryable: true,
      }),
    );
  } finally {
    signal.removeEventListener('abort', abort);
  }
};

export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions' as const;

export class NativeDeepSeekTransport implements JsonTransport {
  async post(
    body: string,
    apiKey: string,
    signal: AbortSignal,
    onHeaders: () => void,
  ): Promise<TransportResponse> {
    return await boundedFetch(
      DEEPSEEK_ENDPOINT,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
      },
      signal,
      onHeaders,
    );
  }
}
