import { describe, expect, it, vi } from 'vitest';

import {
  BoundedFileReadError,
  readBoundedFile,
  type BoundedReadHandle,
  type OpenBoundedReadHandle,
} from './bounded-file-read.js';

const memoryHandle = (
  initial: Buffer,
  growAfterStat = false,
): { handle: BoundedReadHandle; close: ReturnType<typeof vi.fn> } => {
  let content = initial;
  const close = vi.fn(async () => undefined);
  const handle: BoundedReadHandle = {
    stat: async () => {
      const size = content.byteLength;
      if (growAfterStat) content = Buffer.alloc(initial.byteLength + 1, 0x78);
      return { isFile: () => true, size };
    },
    read: async (buffer, offset, length, position) => {
      const bytesRead = Math.min(length, Math.max(0, content.byteLength - position));
      content.copy(buffer, offset, position, position + bytesRead);
      return { bytesRead };
    },
    close,
  };
  return { handle, close };
};

describe('readBoundedFile', () => {
  it.each([16 * 1024, 1_000_000])(
    'accepts exactly %i bytes and never requests more than limit + 1',
    async (limit) => {
      const source = Buffer.alloc(limit, 0x61);
      const reads: number[] = [];
      const close = vi.fn(async () => undefined);
      const openHandle: OpenBoundedReadHandle = async () => ({
        stat: async () => ({ isFile: () => true, size: source.byteLength }),
        read: async (buffer, offset, length, position) => {
          reads.push(length);
          const bytesRead = Math.min(length, Math.max(0, source.byteLength - position));
          source.copy(buffer, offset, position, position + bytesRead);
          return { bytesRead };
        },
        close,
      });

      await expect(readBoundedFile('opaque', limit, openHandle)).resolves.toEqual(source);
      expect(Math.max(...reads)).toBeLessThanOrEqual(limit + 1);
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it.each([16 * 1024, 1_000_000])(
    'rejects growth beyond the %i-byte fstat boundary and closes',
    async (limit) => {
      const { handle, close } = memoryHandle(Buffer.alloc(limit), true);
      const openHandle: OpenBoundedReadHandle = async () => handle;

      await expect(readBoundedFile('opaque', limit, openHandle)).rejects.toBeInstanceOf(
        BoundedFileReadError,
      );
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it('keeps reading the originally opened file when its path is replaced', async () => {
    let pathContent = Buffer.from('original');
    const openHandle = vi.fn<OpenBoundedReadHandle>(async () => {
      const openedContent = pathContent;
      return {
        stat: async () => {
          pathContent = Buffer.from('replacement-content');
          return { isFile: () => true, size: openedContent.byteLength };
        },
        read: async (buffer, offset, length, position) => {
          const bytesRead = Math.min(length, Math.max(0, openedContent.byteLength - position));
          openedContent.copy(buffer, offset, position, position + bytesRead);
          return { bytesRead };
        },
        close: async () => undefined,
      };
    });

    const result = await readBoundedFile('selected-path', 1024, openHandle);
    expect(openHandle).toHaveBeenCalledOnce();
    expect(pathContent.toString('utf8')).toBe('replacement-content');
    expect(result.toString('utf8')).toBe('original');
  });

  it('closes after stat and read failures without exposing path or content in validation errors', async () => {
    const secretPath = 'C:\\private\\secret.txt';
    const secretContent = 'sensitive-content';
    const closeAfterStat = vi.fn(async () => undefined);
    const statFailure: OpenBoundedReadHandle = async () => ({
      stat: async () => ({ isFile: () => false, size: 0 }),
      read: async () => ({ bytesRead: 0 }),
      close: closeAfterStat,
    });
    let error: unknown;
    try {
      await readBoundedFile(secretPath, 10, statFailure);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BoundedFileReadError);
    expect(String(error)).not.toContain(secretPath);
    expect(String(error)).not.toContain(secretContent);
    expect(closeAfterStat).toHaveBeenCalledOnce();

    const closeAfterRead = vi.fn(async () => undefined);
    const readFailure: OpenBoundedReadHandle = async () => ({
      stat: async () => ({ isFile: () => true, size: 1 }),
      read: async () => {
        throw new Error('read failed');
      },
      close: closeAfterRead,
    });
    await expect(readBoundedFile('opaque', 10, readFailure)).rejects.toThrow('read failed');
    expect(closeAfterRead).toHaveBeenCalledOnce();
  });
});
