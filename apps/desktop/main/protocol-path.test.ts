import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isTrustedRendererUrl, rendererFileForRequest } from './protocol-path.js';

describe('controlled renderer protocol', () => {
  const root = path.resolve('C:/application/renderer');

  it('maps only GET app://bundle resources contained by the renderer root', () => {
    expect(rendererFileForRequest(root, { method: 'GET', url: 'app://bundle/index.html' })).toBe(
      path.join(root, 'index.html'),
    );
    expect(
      rendererFileForRequest(root, { method: 'GET', url: 'app://bundle/assets/editor.js' }),
    ).toBe(path.join(root, 'assets/editor.js'));
    for (const url of [
      'app://other/index.html',
      'file:///C:/secret.txt',
      'app://bundle/%2e%2e/secret.txt',
      'app://bundle/%5c..%5csecret.txt',
      'app://user:pass@bundle/index.html',
    ]) {
      expect(rendererFileForRequest(root, { method: 'GET', url })).toBeUndefined();
    }
    expect(
      rendererFileForRequest(root, { method: 'POST', url: 'app://bundle/index.html' }),
    ).toBeUndefined();
  });

  it('accepts only the production bundle or the exact development origin', () => {
    expect(isTrustedRendererUrl('app://bundle/index.html')).toBe(true);
    expect(isTrustedRendererUrl('app://other/index.html')).toBe(false);
    expect(isTrustedRendererUrl('https://bundle/index.html')).toBe(false);
    expect(isTrustedRendererUrl('http://localhost:5173/page', 'http://localhost:5173/')).toBe(true);
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/page', 'http://localhost:5173/')).toBe(
      false,
    );
  });
});
