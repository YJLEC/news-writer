import { z } from 'zod';

export const documentStyleTokensSchema = z
  .object({
    pageWidthTwips: z.number().int().positive().max(100_000),
    pageHeightTwips: z.number().int().positive().max(100_000),
    marginTopTwips: z.number().int().nonnegative().max(100_000),
    marginRightTwips: z.number().int().nonnegative().max(100_000),
    marginBottomTwips: z.number().int().nonnegative().max(100_000),
    marginLeftTwips: z.number().int().nonnegative().max(100_000),
    titleFontFamily: z.string().trim().min(1).max(200),
    bodyFontFamily: z.string().trim().min(1).max(200),
    titleFontSizePt: z.number().positive().max(200),
    bodyFontSizePt: z.number().positive().max(200),
    titleBold: z.boolean(),
    titleAlignment: z.enum(['left', 'center', 'right']),
    bodyAlignment: z.enum(['left', 'center', 'right', 'justify']),
    firstLineIndentPt: z.number().nonnegative().max(500),
    titleLineSpacing: z.number().positive().max(10),
    lineSpacing: z.number().positive().max(10),
    paragraphSpacingBeforePt: z.number().nonnegative().max(500),
    paragraphSpacingAfterPt: z.number().nonnegative().max(500),
    signoffAlignment: z.enum(['left', 'center', 'right']),
  })
  .strict();
export type DocumentStyleTokens = z.infer<typeof documentStyleTokensSchema>;

export const DOCUMENT_TEMPLATE_VERSION = 'standard_business_brief.zh_news_a4.v1' as const;
export const DOCUMENT_MAX_INPUT_BYTES = 16 * 1024 * 1024;
export const DOCUMENT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const bounded = (max: number, min = 1) => z.string().min(min).max(max);

export const newsDocumentSchema = z
  .object({
    title: bounded(500),
    bodyParagraphs: z.array(bounded(20_000)).min(1).max(2_000),
    signOff: bounded(500),
    dateText: bounded(32),
    // A user-supplied date may be a valid but non-calendar phrase such as
    // "2026年8月". Keep a separate machine-safe stamp for the file name.
    dateStamp: z.string().regex(/^(?:20\d{6}|unknown)$/u),
  })
  .strict();
export type NewsDocument = z.infer<typeof newsDocumentSchema>;

export const documentWorkerRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    document: newsDocumentSchema,
    style: documentStyleTokensSchema.optional(),
  })
  .strict();
export const documentWorkerResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({ requestId: z.string().uuid(), ok: z.literal(true), bytes: z.instanceof(Uint8Array) })
    .strict(),
  z
    .object({
      requestId: z.string().uuid(),
      ok: z.literal(false),
      code: z.literal('DOCUMENT_GENERATION_FAILED'),
    })
    .strict(),
]);
export type DocumentWorkerRequest = z.infer<typeof documentWorkerRequestSchema>;
export type DocumentWorkerResponse = z.infer<typeof documentWorkerResponseSchema>;

export const isDocumentWorkerRequestWithinLimit = (value: unknown): boolean => {
  try {
    const serialized = JSON.stringify(value);
    return (
      serialized !== undefined &&
      new TextEncoder().encode(serialized).byteLength <= DOCUMENT_MAX_INPUT_BYTES
    );
  } catch {
    return false;
  }
};

export const boundedDocumentWorkerRequestSchema = documentWorkerRequestSchema.refine(
  isDocumentWorkerRequestWithinLimit,
  'Document worker request exceeds the byte limit',
);

export class DocumentError extends Error {
  constructor(
    readonly code: 'DOCUMENT_CONTENT_INVALID' | 'DOCUMENT_GENERATION_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'DocumentError';
  }
}
