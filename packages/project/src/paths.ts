import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { projectRelativePathSchema, type ProjectRelativePath } from '@news-writer/shared';

import { ProjectError, mapFileSystemError } from './errors.js';

export const canonicalizeProjectRoot = async (root: string): Promise<string> => {
  try {
    return await realpath(root);
  } catch (error) {
    throw mapFileSystemError(error);
  }
};

export const canonicalizeNewProjectTarget = async (targetRoot: string): Promise<string> => {
  const parent = path.dirname(path.resolve(targetRoot));
  const name = path.basename(path.resolve(targetRoot));
  if (name.length === 0 || name === '.' || name === '..' || /[. ]$/.test(name)) {
    throw new ProjectError('PROJECT_PATH_INVALID', 'The project directory name is invalid');
  }
  try {
    const canonicalParent = await realpath(parent);
    return path.join(canonicalParent, name);
  } catch (error) {
    throw mapFileSystemError(error);
  }
};

export const toProjectRelativePath = (value: string): ProjectRelativePath =>
  projectRelativePathSchema.parse(value.replaceAll(path.sep, '/'));

export const resolveProjectPath = (root: string, relativePath: ProjectRelativePath): string => {
  const parsed = projectRelativePathSchema.safeParse(relativePath);
  if (!parsed.success) {
    throw new ProjectError('PROJECT_PATH_INVALID', 'A project-relative path is invalid');
  }
  const candidate = path.resolve(root, ...parsed.data.split('/'));
  const relative = path.relative(root, candidate);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new ProjectError('PROJECT_PATH_ESCAPE', 'A project path escaped the project root');
  }
  return candidate;
};

export const assertPathHasNoReparsePoint = async (
  root: string,
  relativePath: ProjectRelativePath,
  allowMissingLeaf = false,
): Promise<void> => {
  const segments = relativePath.split('/');
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) continue;
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        throw new ProjectError('PROJECT_PATH_ESCAPE', 'Project storage cannot contain links');
      }
    } catch (error) {
      if (
        allowMissingLeaf &&
        index === segments.length - 1 &&
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        return;
      }
      throw mapFileSystemError(error);
    }
  }
};

export const assertExistingAncestorsHaveNoReparsePoint = async (
  root: string,
  relativePath: ProjectRelativePath,
): Promise<void> => {
  const segments = relativePath.split('/');
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        throw new ProjectError('PROJECT_PATH_ESCAPE', 'Project storage cannot contain links');
      }
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        return;
      }
      throw mapFileSystemError(error);
    }
  }
};

export const projectSessionKey = (canonicalRoot: string): string =>
  process.platform === 'win32' ? canonicalRoot.toLocaleLowerCase('en-US') : canonicalRoot;
