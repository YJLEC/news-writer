import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { knowledgeBundleBytesFromFiles } from '@news-writer/retrieval';

import { INSTITUTION_RESOURCE_PATHS } from './constants.js';
import { validateInstitutionBundleV1 } from './bundle.js';
import type { InstitutionBundleBytes, ValidatedInstitutionBundleV1 } from './schemas.js';

export class InstitutionResourceError extends Error {
  readonly code = 'PROFILE_RESOURCE_INVALID' as const;
  constructor() {
    super('The institution profile resources are missing or invalid.');
    this.name = 'InstitutionResourceError';
  }
}

const readFileSafe = async (root: string, relativePath: string): Promise<Uint8Array> => {
  const filePath = path.resolve(root, relativePath);
  const link = await lstat(filePath);
  if (!link.isFile() || link.isSymbolicLink()) throw new InstitutionResourceError();
  const info = await stat(filePath);
  if (info.size > 200 * 1024 * 1024) throw new InstitutionResourceError();
  return readFile(filePath);
};

export const loadInstitutionBundleFromResourcesPathV1 = async (
  resourcesPath: string,
): Promise<ValidatedInstitutionBundleV1> => {
  const root = path.resolve(resourcesPath);
  try {
    const names: string[] = [];
    const walk = async (directory: string, prefix = ''): Promise<void> => {
      for (const name of await readdir(directory)) {
        const relative = prefix ? `${prefix}/${name}` : name;
        const info = await lstat(path.join(directory, name));
        if (info.isSymbolicLink()) throw new InstitutionResourceError();
        if (info.isDirectory()) await walk(path.join(directory, name), relative);
        else if (info.isFile()) names.push(relative);
        else throw new InstitutionResourceError();
      }
    };
    await walk(root);
    const fixed = ['manifest.json', ...INSTITUTION_RESOURCE_PATHS];
    const fontFiles = names.filter(
      (name) => name.startsWith('fonts/') && name !== 'fonts/manifest.json',
    );
    if (fontFiles.some((name) => name.split('/').length !== 2))
      throw new InstitutionResourceError();
    const expected = [...fixed, ...fontFiles].sort();
    const actual = names.sort();
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index]))
      throw new InstitutionResourceError();
    const [
      manifest,
      institution,
      writingRules,
      promptContract,
      documentStyle,
      fontsManifest,
      corpus,
      index,
      trainingRules,
      metadata,
    ] = await Promise.all([
      readFileSafe(root, 'manifest.json'),
      readFileSafe(root, 'institution.json'),
      readFileSafe(root, 'rules/writing-rules.json'),
      readFileSafe(root, 'rules/prompt-contract.json'),
      readFileSafe(root, 'rules/document-style.json'),
      readFileSafe(root, 'fonts/manifest.json'),
      readFileSafe(root, 'knowledge/corpus.jsonl'),
      readFileSafe(root, 'knowledge/index.json'),
      readFileSafe(root, 'knowledge/training_rules.txt'),
      readFileSafe(root, 'knowledge/metadata.json'),
    ]);
    const fonts = {} as Record<string, Uint8Array>;
    await Promise.all(
      fontFiles.map(async (relativePath) => {
        fonts[relativePath.slice('fonts/'.length)] = await readFileSafe(root, relativePath);
      }),
    );
    const bundle: InstitutionBundleBytes = {
      manifest,
      institution,
      writingRules,
      promptContract,
      documentStyle,
      fontsManifest,
      knowledge: knowledgeBundleBytesFromFiles({ corpus, index, trainingRules, metadata }),
      fonts,
    };
    return validateInstitutionBundleV1(bundle);
  } catch (error) {
    if (error instanceof InstitutionResourceError) throw error;
    throw new InstitutionResourceError();
  }
};
