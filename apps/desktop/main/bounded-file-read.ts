import { open } from 'node:fs/promises';

export class BoundedFileReadError extends Error {
  constructor() {
    super('The selected file type or size is invalid');
    this.name = 'BoundedFileReadError';
  }
}

export interface BoundedReadHandle {
  stat(): Promise<{ isFile(): boolean; size: number }>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export type OpenBoundedReadHandle = (target: string, flags: 'r') => Promise<BoundedReadHandle>;

const openReadHandle: OpenBoundedReadHandle = async (target, flags) => await open(target, flags);

export const readBoundedFile = async (
  target: string,
  maxBytes: number,
  openHandle: OpenBoundedReadHandle = openReadHandle,
): Promise<Buffer> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new BoundedFileReadError();

  const handle = await openHandle(target, 'r');
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > maxBytes) throw new BoundedFileReadError();

    const buffer = Buffer.alloc(maxBytes + 1);
    let byteLength = 0;
    while (byteLength < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        byteLength,
        buffer.byteLength - byteLength,
        byteLength,
      );
      if (bytesRead === 0) break;
      byteLength += bytesRead;
    }
    if (byteLength > maxBytes) throw new BoundedFileReadError();
    return buffer.subarray(0, byteLength);
  } finally {
    await handle.close();
  }
};
