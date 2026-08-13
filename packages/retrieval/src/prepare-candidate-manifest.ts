import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from './canonical.js';
import { compareCodePointStrings } from './constants.js';
import { sha256Bytes, sha256Text } from './hash.js';
import { parseKnowledgeSourceManifestV1 } from './source.js';

const [sourceRootInput, outputPathInput, ...relativePathInputs] = process.argv.slice(2);
if (
  sourceRootInput === undefined ||
  outputPathInput === undefined ||
  relativePathInputs.length === 0
) {
  throw new Error(
    'Usage: prepare-candidate-manifest <source-root> <output-json> <relative-path>...',
  );
}
const sourceRoot = path.resolve(sourceRootInput);
const sources = await Promise.all(
  [...new Set(relativePathInputs)]
    .map((value) => value.replaceAll('\\', '/'))
    .sort(compareCodePointStrings)
    .map(async (relativePath) => {
      const extension = path.posix.extname(relativePath).toLowerCase();
      if (extension !== '.docx' && extension !== '.pdf') {
        throw new Error(`Unsupported candidate extension: ${extension}`);
      }
      const sourceSha256 = sha256Bytes(
        await readFile(path.resolve(sourceRoot, ...relativePath.split('/'))),
      );
      return {
        sourceId: `src_${sha256Text(`${relativePath}\n${sourceSha256}`).slice(0, 16)}`,
        relativePath,
        sourceSha256,
        format: extension.slice(1),
        projectPurposeAuthorizationId: 'user-project-purpose-authorization-2026-08-09',
        redistributionScope: 'internal-app',
        redistributionReviewId: '',
        authorizationStatus: 'approved',
        privacyReviewId: '',
        privacyReviewStatus: 'pending',
      };
    }),
);
const manifest = parseKnowledgeSourceManifestV1({
  format: 'news-writer-knowledge-source-manifest',
  schemaVersion: 1,
  sourceRootSha256: sha256Text('news-built-in-college-news-source-root-v1'),
  sources,
});
await writeFile(path.resolve(outputPathInput), canonicalJson(manifest), {
  encoding: 'utf8',
  flag: 'wx',
});
console.log(`Prepared ${manifest.sources.length} explicit candidate sources.`);
