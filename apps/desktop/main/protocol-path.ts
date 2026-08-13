import { normalize, relative, resolve } from 'node:path';

export const isTrustedRendererUrl = (value: string, developmentUrl?: string): boolean => {
  if (developmentUrl !== undefined) {
    try {
      return new URL(value).origin === new URL(developmentUrl).origin;
    } catch {
      return false;
    }
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === 'app:' &&
      url.hostname === 'bundle' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
};

export const rendererFileForRequest = (
  rendererRoot: string,
  request: Pick<Request, 'method' | 'url'>,
): string | undefined => {
  if (request.method !== 'GET') return undefined;
  if (/%2e|%5c|\\|\0/i.test(request.url)) return undefined;
  const url = new URL(request.url);
  if (url.protocol !== 'app:' || url.hostname !== 'bundle' || url.username || url.password) {
    return undefined;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return undefined;
  const logical = normalize(pathname.replace(/^\/+/, ''));
  const target = resolve(rendererRoot, logical);
  const relation = relative(rendererRoot, target);
  if (relation === '' || relation.startsWith('..') || resolve(rendererRoot, relation) !== target) {
    return undefined;
  }
  return target;
};
