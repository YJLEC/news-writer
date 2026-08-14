import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, expect, test } from '@playwright/test';
import electronPath from 'electron';

interface E2eApi {
  auth: {
    setDeepSeekApiKey(input: { apiKey: string }): Promise<unknown>;
    getStatus(): Promise<unknown>;
    clearDeepSeekApiKey(input: { confirmed: true }): Promise<unknown>;
  };
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const electronExecutablePath = electronPath as unknown as string;

test('starts with a sandboxed renderer and a narrow preload bridge', async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'nw-electron-e2e-'));
  const electronApp = await electron.launch({
    executablePath: electronExecutablePath,
    args: [path.join(repositoryRoot, 'apps/desktop'), `--user-data-dir=${userData}`],
  });

  try {
    const page = await electronApp.firstWindow();
    const rendererErrors: string[] = [];
    page.on('pageerror', (error) => rendererErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        rendererErrors.push(message.text());
      }
    });

    expect(page.url()).toBe('app://bundle/index.html');
    expect(await page.content()).toContain('<div id="root">');
    await expect(page.getByRole('heading', { name: 'News Writer' })).toBeVisible();
    await expect(page.locator('[data-monaco-status]')).toHaveAttribute(
      'data-monaco-status',
      'ready',
    );
    expect(page.workers().length).toBeGreaterThan(0);

    const preferences = await electronApp.evaluate(({ BrowserWindow }) => {
      const appWindow = BrowserWindow.getAllWindows()[0];
      if (!appWindow) {
        throw new Error('Expected a BrowserWindow.');
      }
      const webContents = appWindow.webContents as unknown as {
        getLastWebPreferences(): {
          contextIsolation?: boolean;
          nodeIntegration?: boolean;
          sandbox?: boolean;
          webSecurity?: boolean;
        };
      };
      const values = webContents.getLastWebPreferences();
      return {
        contextIsolation: values.contextIsolation,
        nodeIntegration: values.nodeIntegration,
        sandbox: values.sandbox,
        webSecurity: values.webSecurity,
      };
    });

    expect(preferences).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });

    const rendererBoundary = await page.evaluate(async () => {
      const rendererGlobal = globalThis as unknown as {
        newsWriter: Record<string, unknown> & {
          runtime: {
            getInfo(): Promise<{
              ok: boolean;
              data?: { electronVersion: string };
            }>;
          };
        };
        process?: unknown;
        require?: unknown;
      };
      return {
        bridgeKeys: Object.keys(rendererGlobal.newsWriter),
        nodeProcessType: typeof rendererGlobal.process,
        requireType: typeof rendererGlobal.require,
        nestedBridgeKeys: Object.fromEntries(
          Object.entries(rendererGlobal.newsWriter).map(([key, value]) => [
            key,
            Object.keys(value as object),
          ]),
        ),
        runtime: await rendererGlobal.newsWriter.runtime.getInfo(),
      };
    });

    expect(rendererBoundary.bridgeKeys).toEqual([
      'runtime',
      'auth',
      'projects',
      'comments',
      'prompts',
      'settings',
      'retrieval',
      'tasks',
      'documents',
    ]);
    expect(rendererBoundary.nestedBridgeKeys).toEqual({
      runtime: ['getInfo'],
      auth: ['getStatus', 'setDeepSeekApiKey', 'clearDeepSeekApiKey'],
      projects: [
        'createWithDialog',
        'openWithDialog',
        'resumeOwned',
        'recoverOpen',
        'close',
        'refresh',
        'saveMinutes',
        'importMinutesWithDialog',
        'updateConfig',
        'setArchived',
        'setLatestVersion',
      ],
      comments: ['add', 'edit'],
      prompts: ['prepare'],
      settings: ['getUserConfig', 'updateUserConfig', 'previewConfig'],
      retrieval: ['search'],
      tasks: ['start', 'cancel', 'onStatus'],
      documents: ['exportWithDialog'],
    });
    expect(rendererBoundary.nodeProcessType).toBe('undefined');
    expect(rendererBoundary.requireType).toBe('undefined');
    expect(rendererBoundary.runtime).toMatchObject({
      ok: true,
      data: { electronVersion: '43.3.0' },
    });
    expect(page.url()).toBe('app://bundle/index.html');

    const credential = ['synthetic', 'credential', 'value'].join('-');
    const authResult = await page.evaluate(async (value) => {
      const api = (globalThis as unknown as { newsWriter: E2eApi }).newsWriter;
      const saved = await api.auth.setDeepSeekApiKey({ apiKey: value });
      const status = await api.auth.getStatus();
      return { saved, status };
    }, credential);
    expect(authResult.saved).toMatchObject({ ok: true, data: { status: 'configured' } });
    expect(authResult.status).toMatchObject({ ok: true, data: { status: 'configured' } });
    const authDisk = await readFile(path.join(userData, 'auth.json'), 'utf8');
    expect(authDisk).not.toContain(credential);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'News Writer' })).toBeVisible();
    await expect(page.locator('[data-monaco-status]')).toHaveAttribute(
      'data-monaco-status',
      'ready',
    );
    const statusAfterReload = await page.evaluate(async () => {
      const api = (globalThis as unknown as { newsWriter: E2eApi }).newsWriter;
      return await api.auth.getStatus();
    });
    expect(statusAfterReload).toMatchObject({ ok: true, data: { status: 'configured' } });

    const clearResult = await page.evaluate(async () => {
      const api = (globalThis as unknown as { newsWriter: E2eApi }).newsWriter;
      return await api.auth.clearDeepSeekApiKey({ confirmed: true });
    });
    expect(clearResult).toMatchObject({ ok: true, data: { status: 'notConfigured' } });

    const blockedCapabilities = await page.evaluate(async () => {
      const popup = window.open('https://example.com');
      const permission = await navigator.permissions.query({ name: 'notifications' });
      const iframe = document.createElement('iframe');
      iframe.srcdoc = '<p>IPC child-frame probe</p>';
      document.body.append(iframe);
      await new Promise<void>((resolve) => iframe.addEventListener('load', () => resolve()));
      const childApi = (iframe.contentWindow as unknown as { newsWriter?: E2eApi }).newsWriter;
      const childResult =
        childApi === undefined
          ? 'inaccessible'
          : await (
              childApi as E2eApi & {
                runtime?: { getInfo(): Promise<unknown> };
              }
            ).runtime?.getInfo();
      return {
        popupWasDenied: popup === null,
        permission: permission.state,
        childResult,
      };
    });
    expect(blockedCapabilities.popupWasDenied).toBe(true);
    expect(blockedCapabilities.permission).toBe('denied');
    expect(
      blockedCapabilities.childResult === 'inaccessible' ||
        (
          blockedCapabilities.childResult as {
            ok?: boolean;
            error?: { code?: string };
          }
        ).error?.code === 'IPC_SENDER_REJECTED',
    ).toBe(true);
    await page.evaluate(() => {
      window.location.href = 'https://example.com';
    });
    expect(page.url()).toBe('app://bundle/index.html');
    expect(rendererErrors).toEqual([]);
  } finally {
    await electronApp.close();
    await rm(userData, { recursive: true, force: true });
  }
});
