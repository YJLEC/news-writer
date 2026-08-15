import { describe, expect, it } from 'vitest';

import { compressImage } from './imageCompress';

const supportsCanvas = ((): boolean => {
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('2d') !== null;
  } catch {
    return false;
  }
})();
const supportsBitmap = typeof createImageBitmap === 'function';

// happy-dom does not implement createImageBitmap or real 2D canvas drawing, so this
// test is skipped in CI and verified manually in a browser/Electron renderer instead.
describe.skipIf(!supportsCanvas || !supportsBitmap)('imageCompress', () => {
  it('压缩为纯 base64 的 JPEG，最长边不超过 2048 且字节数小于 1MiB', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 4000;
    canvas.height = 3000;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('缺少 Canvas 2D 上下文');
    const gradient = context.createLinearGradient(0, 0, 4000, 3000);
    gradient.addColorStop(0, '#c0392b');
    gradient.addColorStop(1, '#2980b9');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 4000, 3000);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('PNG 编码失败'))),
        'image/png',
      );
    });
    const buffer = await blob.arrayBuffer();
    const result = await compressImage({ buffer, mime: 'image/png' });

    expect(result.dataBase64).not.toContain('data:');
    expect(result.dataBase64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(result.widthPx).toBeLessThanOrEqual(2048);
    expect(result.heightPx).toBeLessThanOrEqual(2048);
    expect(result.widthPx).toBeGreaterThan(0);
    expect(result.heightPx).toBeGreaterThan(0);

    const binaryLength = atob(result.dataBase64).length;
    expect(binaryLength).toBeLessThan(1024 * 1024);
  });
});
