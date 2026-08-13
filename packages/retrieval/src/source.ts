import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import mammoth from 'mammoth';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { z } from 'zod';

import { canonicalJson } from './canonical.js';
import { compareCodePointStrings } from './constants.js';
import { sha256Bytes } from './hash.js';
import { normalizeRetrievalTextV1 } from './normalization.js';
import { redactKnowledgeCandidateV1, type RedactionCategory } from './redaction.js';
import {
  knowledgeSourceManifestV1Schema,
  type CandidateKnowledgeSourceV1,
  type KnowledgeSourceManifestV1,
} from './schemas.js';

export const knowledgeCandidateDocumentV1Schema = z
  .object({
    format: z.literal('news-writer-knowledge-candidate'),
    schemaVersion: z.literal(1),
    sourceId: z.string().regex(/^src_[0-9a-f]{16}$/),
    sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    title: z.string().trim().min(1).max(500),
    normalizedRedactedText: z.string().trim().min(1).max(200_000),
    redactionCounts: z.record(z.string(), z.number().int().nonnegative()),
    authorizationStatus: z.literal('approved'),
    privacyReviewStatus: z.enum(['pending', 'approved', 'rejected']),
  })
  .strict();

export type KnowledgeCandidateDocumentV1 = z.infer<typeof knowledgeCandidateDocumentV1Schema>;

export const approvedKnowledgeCandidateDocumentV1Schema = knowledgeCandidateDocumentV1Schema
  .extend({ privacyReviewStatus: z.literal('approved') })
  .strict();

export type ApprovedKnowledgeCandidateDocumentV1 = z.infer<
  typeof approvedKnowledgeCandidateDocumentV1Schema
>;

const assertUniqueManifestSources = (manifest: KnowledgeSourceManifestV1): void => {
  const ids = new Set<string>();
  const hashes = new Set<string>();
  for (const source of manifest.sources) {
    if (ids.has(source.sourceId)) throw new Error(`Duplicate source ID: ${source.sourceId}`);
    if (hashes.has(source.sourceSha256)) throw new Error('Duplicate source hash in manifest.');
    ids.add(source.sourceId);
    hashes.add(source.sourceSha256);
  }
};

export const parseKnowledgeSourceManifestV1 = (input: unknown): KnowledgeSourceManifestV1 => {
  const manifest = knowledgeSourceManifestV1Schema.parse(input);
  assertUniqueManifestSources(manifest);
  return manifest;
};

const secureSourcePath = async (
  sourceRoot: string,
  source: CandidateKnowledgeSourceV1,
): Promise<string> => {
  const root = await realpath(sourceRoot);
  const candidate = path.resolve(root, ...source.relativePath.split('/'));
  const resolved = await realpath(candidate);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Source path escapes root.');
  const details = await lstat(candidate);
  if (!details.isFile() || details.isSymbolicLink())
    throw new Error('Source must be a regular file.');
  const extension = path.extname(candidate).toLowerCase();
  const expected = source.format === 'utf8-text' ? '.txt' : `.${source.format}`;
  if (extension !== expected) throw new Error('Source extension does not match manifest format.');
  return candidate;
};

const extractPdfText = async (bytes: Uint8Array): Promise<string> => {
  const task = getDocument({ data: new Uint8Array(bytes) });
  const pages: string[] = [];
  try {
    const document = await task.promise;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      let pageText = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        pageText += item.str;
        pageText += item.hasEOL ? '\n' : ' ';
      }
      const normalizedPage = normalizeRetrievalTextV1(pageText);
      if (normalizedPage.length === 0) throw new Error(`PDF page ${pageNumber} has no text layer.`);
      pages.push(normalizedPage);
    }
  } finally {
    await task.destroy();
  }
  return pages.join('\n\n');
};

const extractSourceText = async (
  source: CandidateKnowledgeSourceV1,
  bytes: Uint8Array,
): Promise<string> => {
  if (source.format === 'docx') {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    if (result.messages.length > 0) throw new Error('DOCX extraction produced warnings.');
    return result.value;
  }
  if (source.format === 'pdf') return extractPdfText(bytes);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
};

const splitTitle = (text: string): { title: string; body: string } => {
  const normalized = normalizeRetrievalTextV1(text);
  const paragraphs = normalized
    .split(/\n+/u)
    .map((value) => value.trim())
    .filter(Boolean);
  const title = paragraphs.shift();
  if (title === undefined) throw new Error('Extracted source is empty.');
  const body = paragraphs.join('\n\n');
  if (body.length === 0) throw new Error('Extracted source has no body.');
  return { title, body };
};

const mergeCounts = (
  values: readonly Record<RedactionCategory, number>[],
): Record<string, number> => {
  const result: Record<string, number> = {};
  for (const value of values) {
    for (const [key, count] of Object.entries(value)) result[key] = (result[key] ?? 0) + count;
  }
  return result;
};

export const extractKnowledgeCandidatesV1 = async (input: {
  sourceRoot: string;
  outputDirectory: string;
  manifest: KnowledgeSourceManifestV1;
}): Promise<readonly KnowledgeCandidateDocumentV1[]> => {
  const manifest = parseKnowledgeSourceManifestV1(input.manifest);
  await mkdir(input.outputDirectory, { recursive: true });
  const candidates: KnowledgeCandidateDocumentV1[] = [];
  for (const source of [...manifest.sources].sort((left, right) =>
    compareCodePointStrings(left.sourceId, right.sourceId),
  )) {
    if (source.privacyReviewStatus === 'rejected') continue;
    const sourcePath = await secureSourcePath(input.sourceRoot, source);
    const bytes = await readFile(sourcePath);
    if (sha256Bytes(bytes) !== source.sourceSha256) throw new Error('Source hash mismatch.');
    const extracted = await extractSourceText(source, bytes);
    const { title, body } = splitTitle(extracted);
    const titleResult = redactKnowledgeCandidateV1(title);
    const bodyResult = redactKnowledgeCandidateV1(body);
    const candidate = knowledgeCandidateDocumentV1Schema.parse({
      format: 'news-writer-knowledge-candidate',
      schemaVersion: 1,
      sourceId: source.sourceId,
      sourceSha256: source.sourceSha256,
      title: titleResult.redactedText,
      normalizedRedactedText: bodyResult.redactedText,
      redactionCounts: mergeCounts([titleResult.counts, bodyResult.counts]),
      authorizationStatus: source.authorizationStatus,
      privacyReviewStatus: source.privacyReviewStatus,
    });
    await writeFile(
      path.join(input.outputDirectory, `${source.sourceId}.json`),
      canonicalJson(candidate),
      {
        encoding: 'utf8',
        flag: 'wx',
      },
    );
    candidates.push(candidate);
  }
  return candidates;
};
