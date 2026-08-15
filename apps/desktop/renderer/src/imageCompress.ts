/**
 * Pure browser-side image compression. Uses only Web APIs (no Node/fs), so it can
 * run inside the Electron renderer sandbox. Images are re-encoded as JPEG with a
 * bounded longest edge and a target byte budget of 1 MiB.
 */

const MAX_DIMENSION = 2048;
const MAX_BYTES = 1024 * 1024;
const MIN_LONGEST_EDGE = 256;
const DIMENSION_STEP = 0.8;
// Quality ladder: start high, step down. 0.30 is the floor before we shrink pixels.
const QUALITY_STEPS = [0.88, 0.8, 0.72, 0.64, 0.56, 0.48, 0.4, 0.32, 0.3] as const;

export interface CompressedImage {
  dataBase64: string;
  widthPx: number;
  heightPx: number;
}

export type ImageSource = File | { buffer: ArrayBuffer; mime: string };

const loadBitmap = async (source: ImageSource): Promise<ImageBitmap> => {
  const blob = source instanceof File ? source : new Blob([source.buffer], { type: source.mime });
  return await createImageBitmap(blob, { imageOrientation: 'from-image' });
};

const encodeJpeg = (
  bitmap: ImageBitmap,
  width: number,
  height: number,
  quality: number,
): Promise<Blob> => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建 Canvas 2D 上下文。');
  context.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('JPEG 编码失败。'))),
      'image/jpeg',
      quality,
    );
  });
};

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('读取图片数据失败。'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取图片数据失败。'));
    reader.readAsDataURL(blob);
  });

export const compressImage = async (source: ImageSource): Promise<CompressedImage> => {
  const bitmap = await loadBitmap(source);
  try {
    const sourceWidth = bitmap.width;
    const sourceHeight = bitmap.height;
    const longestEdge = Math.max(sourceWidth, sourceHeight);
    if (sourceWidth <= 0 || sourceHeight <= 0) throw new Error('图片尺寸无效。');

    let scale = Math.min(1, MAX_DIMENSION / longestEdge);
    let lastEncoded: { blob: Blob; widthPx: number; heightPx: number } | null = null;

    for (;;) {
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      for (const quality of QUALITY_STEPS) {
        const encoded = await encodeJpeg(bitmap, width, height, quality);
        lastEncoded = { blob: encoded, widthPx: width, heightPx: height };
        if (encoded.size <= MAX_BYTES) {
          return { dataBase64: await blobToBase64(encoded), widthPx: width, heightPx: height };
        }
      }
      const nextScale = scale * DIMENSION_STEP;
      if (Math.max(1, Math.round(longestEdge * nextScale)) < MIN_LONGEST_EDGE) break;
      scale = nextScale;
    }

    // lastEncoded always holds the smallest (lowest-quality) encode attempted at the
    // current scale; return it as a best effort once shrinking would go too far.
    const fallback = lastEncoded as { blob: Blob; widthPx: number; heightPx: number };
    return {
      dataBase64: await blobToBase64(fallback.blob),
      widthPx: fallback.widthPx,
      heightPx: fallback.heightPx,
    };
  } finally {
    bitmap.close();
  }
};
