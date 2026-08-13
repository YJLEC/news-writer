import { describe, expect, it } from 'vitest';

import {
  compareTimestamps,
  containsSecretMaterial,
  projectIdSchema,
  projectRelativePathSchema,
  safeAppErrorSchema,
  textArtifactRefSchema,
  timestampSchema,
} from './index';

describe('shared value schemas', () => {
  it('detects common and exact credential material across all supplied text values', () => {
    const bearerSentinel = ['Bearer', ' ', 'ABCDEFGHIJKLMNOP'].join('');
    const skSentinel = ['S', 'K-', 'abcdefghijklmnop'].join('');
    expect(containsSecretMaterial(['safe', bearerSentinel])).toBe(true);
    expect(containsSecretMaterial([skSentinel])).toBe(true);
    expect(containsSecretMaterial(['contains exact-value'], ['exact-value'])).toBe(true);
    expect(containsSecretMaterial(['ordinary news copy'], ['exact-value'])).toBe(false);
  });

  it('accepts lowercase branded UUIDs and rejects noncanonical values', () => {
    expect(projectIdSchema.parse('00000000-0000-4000-8000-000000000001')).toBeTruthy();
    expect(() => projectIdSchema.parse('00000000-0000-4000-8000-00000000000A')).toThrow();
    expect(() => projectIdSchema.parse('not-an-id')).toThrow();
  });

  it('validates calendar dates and compares different fractional precisions', () => {
    const earlier = timestampSchema.parse('2026-08-09T01:02:03.123Z');
    const later = timestampSchema.parse('2026-08-09T01:02:03.1230001Z');
    expect(compareTimestamps(earlier, later)).toBeLessThan(0);
    expect(() => timestampSchema.parse('2026-02-31T01:02:03.123Z')).toThrow();
    expect(() => timestampSchema.parse('2026-08-09T01:02:03Z')).toThrow();
  });

  it.each([
    'C:/project.json',
    '\\\\server\\share',
    '/absolute',
    'content\\file.md',
    'content/../file.md',
    'content/./file.md',
    'content/NUL.txt',
    'content/name:stream',
    'content/trailing. ',
    'content\0file',
  ])('rejects unsafe project-relative path %s', (value) => {
    expect(projectRelativePathSchema.safeParse(value).success).toBe(false);
  });

  it('allows a zero-byte prompt artifact but keeps strict object shape', () => {
    const value = {
      relativePath: projectRelativePathSchema.parse('content/prompts/id/0.txt'),
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      byteLength: 0,
      mediaType: 'text/plain',
      encoding: 'utf-8',
    };
    expect(textArtifactRefSchema.parse(value).byteLength).toBe(0);
    expect(textArtifactRefSchema.safeParse({ ...value, absolutePath: 'C:/secret' }).success).toBe(
      false,
    );
  });

  it('rejects unsafe error detail fields and arbitrary cause codes', () => {
    const base = {
      code: 'PROJECT_IO_ERROR',
      occurredAt: '2026-08-09T01:02:03.123Z',
      safeMessage: 'A file operation failed',
      retryable: false,
    };
    expect(safeAppErrorSchema.safeParse({ ...base, stack: 'secret' }).success).toBe(false);
    expect(safeAppErrorSchema.safeParse({ ...base, causeCode: 'RAW_SECRET' }).success).toBe(false);
    expect(safeAppErrorSchema.safeParse({ ...base, causeCode: 'ENOSPC' }).success).toBe(true);
    expect(safeAppErrorSchema.safeParse({ ...base, code: 'INSUFFICIENT_BALANCE' }).success).toBe(
      true,
    );
  });

  it.each([
    'IPC_PROTOCOL_INVALID',
    'IPC_SENDER_REJECTED',
    'AUTH_STORAGE_UNAVAILABLE',
    'AUTH_STORAGE_CORRUPT',
    'RESOURCE_UNAVAILABLE',
  ])('accepts the Stage 5 safe error code %s', (code) => {
    expect(
      safeAppErrorSchema.safeParse({
        code,
        occurredAt: '2026-08-09T01:02:03.123Z',
        safeMessage: 'Safe message',
        retryable: false,
      }).success,
    ).toBe(true);
  });
});
