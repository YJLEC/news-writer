import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { extractFile, listPackage, statFile } from '@electron/asar';
import { chromium, expect, test } from '@playwright/test';
import { FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses';
import { FuseState } from '@electron/fuses/dist/constants.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executablePath = path.join(repositoryRoot, 'release', 'win-unpacked', 'News Writer.exe');
const smokeExecutablePath = path.join(
  repositoryRoot,
  'release',
  'package-smoke',
  'win-unpacked',
  'News Writer Package Smoke.exe',
);
const appArchivePath = path.join(
  repositoryRoot,
  'release',
  'win-unpacked',
  'resources',
  'app.asar',
);
const noticesPath = path.join(
  repositoryRoot,
  'release',
  'win-unpacked',
  'resources',
  'THIRD-PARTY-NOTICES.txt',
);
const institutionRoot = path.join(
  repositoryRoot,
  'release',
  'win-unpacked',
  'resources',
  'institution',
);
const smokeInstitutionRoot = path.join(
  repositoryRoot,
  'release',
  'package-smoke',
  'win-unpacked',
  'resources',
  'institution',
);
const approvedInstitutionFiles = new Set([
  'manifest.json',
  'institution.json',
  'rules/writing-rules.json',
  'rules/prompt-contract.json',
  'rules/document-style.json',
  'knowledge/corpus.jsonl',
  'knowledge/index.json',
  'knowledge/training_rules.txt',
  'knowledge/metadata.json',
  'fonts/manifest.json',
]);

const collectFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? collectFiles(entryPath) : [entryPath];
  });

const launchPackagedRenderer = async () => {
  const processHandle = spawn(executablePath, ['--remote-debugging-port=0'], {
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: 'data:text/html,<h1 id="probe">Injected renderer</h1>',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const endpoint = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for the packaged renderer debugging endpoint.'));
    }, 10_000);
    const onOutput = (data: Buffer): void => {
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(data.toString('utf8'));
      if (match?.[1]) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    };

    processHandle.stdout.on('data', onOutput);
    processHandle.stderr.on('data', onOutput);
    processHandle.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    processHandle.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Packaged application exited before CDP was ready (code ${String(code)}).`));
    });
  });

  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error('Packaged application did not expose a browser context.');
  }
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));

  return {
    browser,
    page,
    stop: async (): Promise<void> => {
      await browser.close();
      if (processHandle.exitCode === null) {
        processHandle.kill();
        await once(processHandle, 'exit');
      }
    },
  };
};

test('starts from the packaged directory without a development server', async () => {
  expect(fs.existsSync(executablePath)).toBe(true);

  const packagedApp = await launchPackagedRenderer();
  try {
    const { page } = packagedApp;
    const rendererErrors: string[] = [];
    page.on('pageerror', (error) => rendererErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        rendererErrors.push(message.text());
      }
    });
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: 'News Writer' })).toBeVisible();
    await expect(page.locator('[data-monaco-status]')).toHaveAttribute(
      'data-monaco-status',
      'ready',
    );
    expect(page.workers().length).toBeGreaterThan(0);
    expect(page.url()).toBe('app://bundle/index.html');
    await expect(page.locator('#probe')).toHaveCount(0);

    const runtime = await page.evaluate(async () => {
      const rendererGlobal = globalThis as unknown as {
        newsWriter: {
          runtime: {
            getInfo(): Promise<unknown>;
          };
        };
      };
      return await rendererGlobal.newsWriter.runtime.getInfo();
    });
    expect(runtime).toMatchObject({
      ok: true,
      data: {
        electronVersion: '43.3.0',
        platform: 'win32',
        arch: 'x64',
      },
    });
    expect(
      (runtime as { ok: true; data: { knowledgeVersion: unknown } }).data.knowledgeVersion,
    ).toMatch(/^kw_[0-9a-f]{16}_[0-9a-f]{16}$/u);
    expect((runtime as { ok: true; data: { profileId: unknown } }).data.profileId).toBe(
      'profile_synthetic-public',
    );
    expect(rendererErrors).toEqual([]);
  } finally {
    await packagedApp.stop();
  }
});

test('starts the packaged document worker from app.asar and audits its output', async () => {
  const processHandle = spawn(smokeExecutablePath, [], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  processHandle.stdout.on('data', (data: Buffer) => {
    output += data.toString('utf8');
  });
  processHandle.stderr.on('data', (data: Buffer) => {
    output += data.toString('utf8');
  });
  const [code] = (await once(processHandle, 'exit')) as [number | null];
  expect(code, output).toBe(0);
  expect(output).toMatch(/NW_DOCUMENT_WORKER_SMOKE_OK \d+/u);
});

test('uses the approved Electron fuse baseline', async () => {
  const fuses = await getCurrentFuseWire(executablePath);

  expect(fuses.version).toBe(FuseVersion.V1);
  expect(fuses[FuseV1Options.RunAsNode]).toBe(FuseState.DISABLE);
  expect(fuses[FuseV1Options.EnableCookieEncryption]).toBe(FuseState.ENABLE);
  expect(fuses[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(FuseState.DISABLE);
  expect(fuses[FuseV1Options.EnableNodeCliInspectArguments]).toBe(FuseState.DISABLE);
  expect(fuses[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(FuseState.ENABLE);
  expect(fuses[FuseV1Options.OnlyLoadAppFromAsar]).toBe(FuseState.ENABLE);
  expect(fuses[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]).toBe(FuseState.DISABLE);
  expect(fuses[FuseV1Options.GrantFileProtocolExtraPrivileges]).toBe(FuseState.DISABLE);
});

test('contains only the approved application payload', () => {
  expect(fs.existsSync(appArchivePath)).toBe(true);

  const archiveFiles = listPackage(appArchivePath, { isPack: false })
    .map((entry) => entry.slice(1))
    .filter((entry) => !('files' in statFile(appArchivePath, entry)));
  const productionMain = extractFile(
    appArchivePath,
    path.join('apps', 'desktop', 'out', 'main', 'index.js'),
  ).toString('utf8');
  expect(productionMain).not.toContain('NW_PACKAGE_DOCUMENT_WORKER_SMOKE');
  expect(productionMain).not.toContain('NW_DOCUMENT_WORKER_SMOKE_OK');
  expect(productionMain).not.toContain('便携包文档工作线程测试');

  const isApprovedArchiveFile = (file: string): boolean =>
    file === 'package.json' ||
    file === 'apps\\desktop\\out\\main\\index.js' ||
    file === 'apps\\desktop\\out\\main\\ai-worker.js' ||
    file === 'apps\\desktop\\out\\main\\document-worker.js' ||
    /^apps\\desktop\\out\\main\\chunks\\[A-Za-z0-9_.-]+\.js$/.test(file) ||
    file === 'apps\\desktop\\out\\preload\\index.cjs' ||
    file === 'apps\\desktop\\out\\renderer\\index.html' ||
    /^apps\\desktop\\out\\renderer\\assets\\[A-Za-z0-9_.-]+\.(?:css|js|ttf)$/.test(file);

  for (const file of archiveFiles) {
    expect(isApprovedArchiveFile(file), `Unexpected app.asar entry: ${file}`).toBe(true);
    expect(file).not.toMatch(/(^|\\)\.env(?:\.|$)/i);
    expect(file).not.toMatch(/\.(?:docx?|pdf|pptx?|py)$/i);
    expect(file).not.toMatch(/(^|\\)tests?(?:\\|$)/i);
    expect(file).not.toMatch(/(^|\\)fixtures?(?:\\|$)/i);
  }

  const textExtensions = new Set(['.cjs', '.css', '.html', '.js', '.json']);
  for (const file of archiveFiles.filter((entry) => textExtensions.has(path.extname(entry)))) {
    const content = extractFile(appArchivePath, file).toString('utf8');
    expect(content, `Development URL found in ${file}`).not.toMatch(
      /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])/i,
    );
    expect(content, `Development renderer hook found in ${file}`).not.toContain(
      'ELECTRON_RENDERER_URL',
    );
    expect(content, `Credential marker found in ${file}`).not.toMatch(
      /(?:DEEPSEEK_API_KEY|sk-[A-Za-z0-9_-]{16,}|bearer\s+[A-Za-z0-9._~+/=-]{12,}|(?:apiKey|authorization)["']?\s*[:=]\s*["'][A-Za-z0-9._~+/=-]{12,})/i,
    );
    expect(content, `Absolute development path found in ${file}`).not.toMatch(
      /[A-Za-z]:[\\/](?:Users|workspace)[\\/]/i,
    );
    expect(content, `Fixture reference found in ${file}`).not.toMatch(/tests?[\\/]fixtures?/i);
    expect(content, `Controlled AI marker found in ${file}`).not.toMatch(
      /(?:NW_CONTROLLED_AI_E2E|NW_CONTROLLED_AI_PLAN|news-writer-controlled-ai-(?:e2e|plan)-v1|synthetic-completion-success|e2e-controlled-runner)/,
    );
  }

  const forbiddenExtensions = new Set(['.doc', '.docx', '.pdf', '.pptx', '.py']);
  const packagedFiles = collectFiles(path.join(repositoryRoot, 'release', 'win-unpacked'));
  expect(packagedFiles.filter((file) => forbiddenExtensions.has(path.extname(file)))).toEqual([]);

  const emittedTests = collectFiles(path.join(repositoryRoot, 'packages')).filter(
    (file) => file.includes(`${path.sep}dist${path.sep}`) && /\.test\.[^.]+$/.test(file),
  );
  expect(emittedTests).toEqual([]);
});

test('does not package unapproved institution resources', () => {
  for (const root of [institutionRoot, smokeInstitutionRoot]) {
    if (!fs.existsSync(root)) {
      throw new Error(`Missing packaged institution resources: ${root}`);
    }
    const files = collectFiles(root).map((file) =>
      path.relative(root, file).split(path.sep).join('/'),
    );
    expect(new Set(files)).toEqual(approvedInstitutionFiles);
    expect(files).toHaveLength(approvedInstitutionFiles.size);
    for (const file of files) {
      expect(path.extname(file)).not.toBe('.py');
    }
    expect(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).toContain(
      'synthetic-public-fixture',
    );
  }
});

test('includes notices for the packaged production dependencies', () => {
  expect(fs.existsSync(noticesPath)).toBe(true);
  const notices = fs.readFileSync(noticesPath, 'utf8');

  for (const dependency of [
    'docx',
    'jszip',
    'dompurify',
    'monaco-editor',
    'react',
    'react-dom',
    'zod',
  ]) {
    expect(notices).toContain(`${dependency}@`);
  }
  expect(notices).toContain('DOMPurify is used under the Apache License 2.0 option');
});
