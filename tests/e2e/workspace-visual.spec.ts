import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, expect, test } from '@playwright/test';
import electronPath from 'electron';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const electronExecutablePath = electronPath as unknown as string;
const screenshots = path.join(repositoryRoot, 'tests', 'artifacts', 'stage6');

test('renders the real workspace without overlap at the supported viewports', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nw-stage6-visual-'));
  const userData = path.join(root, 'user-data');
  const projectRoot = path.join(root, 'visual-project');
  await mkdir(screenshots, { recursive: true });
  const electronApp = await electron.launch({
    executablePath: electronExecutablePath,
    args: [path.join(repositoryRoot, 'apps/desktop'), `--user-data-dir=${userData}`],
  });

  try {
    await electronApp.evaluate(({ dialog }, target) => {
      const mutableDialog = dialog as unknown as {
        showSaveDialog: () => Promise<{ canceled: boolean; filePath: string }>;
      };
      mutableDialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: target });
    }, projectRoot);
    const page = await electronApp.firstWindow();
    await expect(page.getByRole('heading', { name: 'News Writer' })).toBeVisible();
    await page.getByRole('button', { name: /DeepSeek：未配置/ }).click();
    await page.getByLabel('API Key').fill('stage6-visual-fixture-key');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('button', { name: /DeepSeek：已配置/ })).toBeVisible();
    await page.getByRole('button', { name: /新建项目/ }).click();
    await page
      .getByLabel('项目名称')
      .fill('长名称测试：计算机学院数字媒体与智能传播联合活动新闻稿项目');
    await page.getByRole('button', { name: '选择目录并创建' }).click();
    await expect(page.locator('.workspace')).toBeVisible();
    await expect(page.locator('[data-testid="monaco-左侧编辑器"]')).toHaveAttribute(
      'data-monaco-status',
      'ready',
    );
    await page.locator('[data-testid="monaco-左侧编辑器"] .view-lines').click();
    await page.keyboard.insertText(
      '8月10日上午，计算机学院在学术报告厅举办数字媒体与智能传播联合活动。',
    );
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    await expect(page.getByText('项目内容已同步')).toBeVisible();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.workspace')).toBeVisible();
    await expect(
      page.getByText('长名称测试：计算机学院数字媒体与智能传播联合活动新闻稿项目'),
    ).toBeVisible();
    await expect(page.getByText('项目内容已同步')).toBeVisible();

    const viewports = [
      { width: 1440, height: 900, name: 'workspace-1440x900.png' },
      { width: 1100, height: 720, name: 'workspace-1100x720.png' },
      { width: 720, height: 480, name: 'workspace-720x480.png' },
    ];
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(120);
      const layout = await page.evaluate(() => ({
        bodyWidth: document.body.scrollWidth,
        bodyHeight: document.body.scrollHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        visibleMonacoLines: [
          ...document.querySelectorAll<HTMLElement>('.monaco-editor .view-line'),
        ].filter((node) => node.offsetParent !== null).length,
        commentsVisible: (() => {
          const pane = document.querySelector<HTMLElement>('.comments-pane');
          if (!pane) return false;
          const style = getComputedStyle(pane);
          return pane.getClientRects().length > 0 && style.visibility !== 'hidden';
        })(),
      }));
      expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
      expect(layout.bodyHeight).toBeLessThanOrEqual(layout.viewportHeight);
      expect(layout.visibleMonacoLines).toBeGreaterThan(0);
      expect(layout.commentsVisible).toBe(true);
      expect(page.workers().length).toBeGreaterThan(0);
      await page.screenshot({ path: path.join(screenshots, viewport.name), fullPage: false });
    }

    await page.getByRole('button', { name: '准备初稿 Prompt' }).click();
    await expect(page.getByRole('button', { name: '编辑 Prompt' })).toBeVisible();
    await page.getByRole('button', { name: '编辑 Prompt' }).click();
    await expect(page.getByRole('dialog', { name: '编辑 Prompt' })).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, 'prompt-warning-720x480.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '编辑 Prompt' })).toBeHidden();
  } finally {
    await electronApp.close();
    await rm(root, { recursive: true, force: true });
  }
});
