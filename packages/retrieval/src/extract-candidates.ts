import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { extractKnowledgeCandidatesV1, parseKnowledgeSourceManifestV1 } from './source.js';

const [sourceRootInput, manifestPathInput, outputDirectoryInput] = process.argv.slice(2);
if (
  sourceRootInput === undefined ||
  manifestPathInput === undefined ||
  outputDirectoryInput === undefined
) {
  throw new Error('Usage: extract-candidates <source-root> <manifest-json> <output-directory>');
}
const manifest = parseKnowledgeSourceManifestV1(
  JSON.parse(await readFile(path.resolve(manifestPathInput), 'utf8')) as unknown,
);
const candidates = await extractKnowledgeCandidatesV1({
  sourceRoot: path.resolve(sourceRootInput),
  outputDirectory: path.resolve(outputDirectoryInput),
  manifest,
});
console.log(`Extracted ${candidates.length} review candidates.`);
