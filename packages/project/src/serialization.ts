import { createHash } from 'node:crypto';

import { type Sha256, sha256Schema } from '@news-writer/shared';
import { type ZodType } from 'zod';

import { ProjectError } from './errors.js';

export const sha256 = (bytes: Uint8Array): Sha256 =>
  sha256Schema.parse(createHash('sha256').update(bytes).digest('hex'));

export const serializeJson = (value: unknown): Buffer =>
  Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');

export const parseJsonBytes = <T>(bytes: Uint8Array, schema: ZodType<T>, maxBytes: number): T => {
  if (bytes.byteLength > maxBytes) {
    throw ProjectError.schemaInvalid('Project JSON exceeds its size limit');
  }
  if (bytes.byteLength === 0 || bytes[0] === 0xef || bytes.at(-1) !== 0x0a) {
    throw ProjectError.schemaInvalid('Project JSON encoding is invalid');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\r') || text.endsWith('\n\n')) {
    throw ProjectError.schemaInvalid('Project JSON line endings are invalid');
  }
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    throw ProjectError.schemaInvalid('Project JSON schema is invalid');
  }
};

export const verifyBytes = (
  bytes: Uint8Array,
  expectedBytes: number,
  expectedSha256: Sha256,
): void => {
  if (bytes.byteLength !== expectedBytes) {
    throw ProjectError.hashMismatch('Project object length does not match its reference');
  }
  if (sha256(bytes) !== expectedSha256) {
    throw ProjectError.hashMismatch('Project object hash does not match its reference');
  }
};
