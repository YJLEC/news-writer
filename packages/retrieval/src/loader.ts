import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { KNOWLEDGE_FILE_NAMES } from './constants.js';
import { validateKnowledgeBundleV1 } from './bundle.js';
import type { KnowledgeBundleBytes, ValidatedKnowledgeBundleV1 } from './schemas.js';

const SIZE_LIMITS = {
  'corpus.jsonl': 100 * 1024 * 1024,
  'index.json': 200 * 1024 * 1024,
  'training_rules.txt': 1024 * 1024,
  'metadata.json': 1024 * 1024,
} as const;

export class KnowledgeResourceError extends Error {
  readonly code = 'KNOWLEDGE_RESOURCE_INVALID' as const;

  constructor() {
    super('The built-in knowledge resources are missing or invalid.');
    this.name = 'KnowledgeResourceError';
  }
}

const readFixedFile = async (
  directory: string,
  fileName: (typeof KNOWLEDGE_FILE_NAMES)[number],
): Promise<Uint8Array> => {
  const filePath = path.join(directory, fileName);
  const linkInfo = await lstat(filePath);
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) throw new KnowledgeResourceError();
  const fileInfo = await stat(filePath);
  if (fileInfo.size > SIZE_LIMITS[fileName]) throw new KnowledgeResourceError();
  return readFile(filePath);
};

export const loadKnowledgeBundleFromResourcesPathV1 = async (
  resourcesPath: string,
): Promise<ValidatedKnowledgeBundleV1> => {
  const directory = path.resolve(resourcesPath, 'knowledge');
  try {
    const names = (await readdir(directory)).sort();
    const expected = [...KNOWLEDGE_FILE_NAMES].sort();
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
      throw new KnowledgeResourceError();
    }
    const [corpus, index, trainingRules, metadata] = await Promise.all([
      readFixedFile(directory, 'corpus.jsonl'),
      readFixedFile(directory, 'index.json'),
      readFixedFile(directory, 'training_rules.txt'),
      readFixedFile(directory, 'metadata.json'),
    ]);
    return validateKnowledgeBundleV1({ corpus, index, trainingRules, metadata });
  } catch (error) {
    if (error instanceof KnowledgeResourceError) throw error;
    throw new KnowledgeResourceError();
  }
};

export const knowledgeBundleBytesFromFiles = (files: {
  corpus: Uint8Array;
  index: Uint8Array;
  trainingRules: Uint8Array;
  metadata: Uint8Array;
}): KnowledgeBundleBytes => files;
