import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, expect, test } from '@playwright/test';
import electronPath from 'electron';

import {
  lockOwnerV1Schema,
  projectHeadV1Schema,
  serializeJson,
} from '../../packages/project/dist/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const electronExecutablePath = electronPath as unknown as string;
const e2eMain = path.join(repositoryRoot, 'apps', 'desktop', 'out-e2e', 'main', 'index.js');

const readHead = async (projectRoot: string) =>
  projectHeadV1Schema.parse(
    JSON.parse(await readFile(path.join(projectRoot, 'project.json'), 'utf8')),
  );

const waitForVersionCount = async (projectRoot: string, count: number): Promise<void> => {
  await expect.poll(async () => (await readHead(projectRoot)).state.versions.length).toBe(count);
};

test('runs a successful generation through the isolated controlled AI entry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nw-controlled-ai-'));
  const userData = path.join(root, 'user-data');
  const projectRoot = path.join(root, 'project');
  const minutes = await readFile(
    path.join(repositoryRoot, 'tests', 'fixtures', 'minutes', 'gf-01-official-complete.md'),
    'utf8',
  );
  const article = [
    '数字素养与信息核验工作坊顺利举行',
    '',
    '2099年4月12日下午，示例学院在教学楼A101举办数字素养与信息核验工作坊。学院本科生代表参加活动。',
    '',
    '活动中，指导教师介绍公开信息核验的基本步骤，学生分组辨认材料来源、时间和数据口径，并交换核验记录。',
    '',
    '活动帮助参与学生掌握信息核验方法，为提升数字素养打下基础。',
  ].join('\n');
  const plan = JSON.stringify({
    schema: 'news-writer-controlled-ai-plan-v1',
    steps: [
      {
        type: 'success',
        content: article,
        completionId: 'synthetic-completion-success-1',
        requestingAfterMs: 10,
        processingAfterMs: 10,
        settleAfterMs: 20,
      },
    ],
  });
  const electronApp = await electron.launch({
    executablePath: electronExecutablePath,
    args: [e2eMain, `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      NW_CONTROLLED_AI_E2E: 'news-writer-controlled-ai-e2e-v1',
      NW_CONTROLLED_AI_PLAN: plan,
    },
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
    await page.getByLabel('API Key').fill('synthetic-controlled-ai-key');
    await page.getByRole('button', { name: '保存' }).click();
    await page.getByRole('button', { name: /新建项目/ }).click();
    await page.getByLabel('项目名称').fill('受控 AI 成功流程');
    await page.getByRole('button', { name: '选择目录并创建' }).click();
    await expect(page.locator('.workspace')).toBeVisible();

    const editor = page.locator('[data-testid="monaco-左侧编辑器"] .view-lines');
    await editor.click();
    await page.keyboard.insertText(minutes);
    await page.keyboard.press('Control+S');
    await expect(page.getByText('项目内容已同步')).toBeVisible();
    await page.getByRole('button', { name: '准备初稿 Prompt' }).click();
    await expect(page.getByRole('button', { name: '生成新版本' })).toBeVisible();
    await page.getByRole('button', { name: '编辑 Prompt' }).click();
    await expect(page.getByRole('dialog', { name: '编辑 Prompt' })).toContainText(
      '修改可能破坏事实约束和写作规范，修改结果由用户承担。',
    );
    await page.getByRole('button', { name: '我已了解，继续编辑' }).click();
    const editedPrompt = [
      '# 用户编辑后的实际 Prompt',
      '',
      '仅根据已保存的活动纪要生成新闻稿。',
      '不得增加未提供的人物、时间或地点。',
    ].join('\n');
    await editor.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(editedPrompt);
    const editorFinalText = await page
      .locator('[data-testid="monaco-左侧编辑器"]')
      .evaluate((element) => {
        const reactFiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
        if (reactFiberKey === undefined) throw new Error('Monaco React fiber is unavailable');
        let fiber = (element as unknown as Record<string, unknown>)[reactFiberKey] as
          | {
              memoizedProps?: { ariaLabel?: unknown; value?: unknown };
              return?: unknown;
            }
          | undefined;
        while (fiber !== undefined) {
          if (
            fiber.memoizedProps?.ariaLabel === '左侧编辑器' &&
            typeof fiber.memoizedProps.value === 'string'
          ) {
            return fiber.memoizedProps.value;
          }
          fiber = fiber.return as typeof fiber;
        }
        throw new Error('Monaco model value is unavailable');
      });
    expect(editorFinalText).toBe(editedPrompt);
    await page.getByRole('button', { name: '生成新版本' }).click();
    const riskDialog = page.getByRole('dialog', { name: '确认生成风险' });
    if (await riskDialog.isVisible()) {
      await riskDialog.getByRole('button', { name: '已了解并继续' }).click();
    }
    await expect(page.locator('.task-summary strong')).toHaveText('已完成', { timeout: 10_000 });
    await expect(page.getByText(article.split('\n')[0]!, { exact: true })).toBeVisible();

    const head = projectHeadV1Schema.parse(
      JSON.parse(await readFile(path.join(projectRoot, 'project.json'), 'utf8')),
    );
    expect(head.state.versions).toHaveLength(1);
    expect(head.state.tasks).toHaveLength(1);
    expect(head.state.latestVersionId).toBe(head.state.versions[0]!.entityId);
    const taskRef = head.state.tasks[0]!;
    const task = JSON.parse(
      await readFile(path.join(projectRoot, taskRef.relativePath), 'utf8'),
    ) as {
      payload: {
        status: string;
        resultVersionId?: string;
        promptId: string;
        parentVersionId: string | null;
      };
    };
    expect(task.payload.status).toBe('succeeded');
    expect(task.payload.resultVersionId).toBe(head.state.latestVersionId);
    expect(task.payload.parentVersionId).toBeNull();
    expect(head.state.prompts).toHaveLength(1);
    const promptRef = head.state.prompts[0]!;
    expect(promptRef.entityId).toBe(task.payload.promptId);
    const promptRecord = JSON.parse(
      await readFile(path.join(projectRoot, promptRef.relativePath), 'utf8'),
    ) as {
      payload: {
        purpose: string;
        editedByUser: boolean;
        editWarningAcknowledgedAt?: string;
        upstream: {
          promptInputFingerprint: string;
          currentInputFingerprint: string;
          staleResolution: string;
          previousPromptInputFingerprint?: string;
        };
        messages: Array<{ contentRef: { relativePath: string } }>;
      };
    };
    expect(promptRecord.payload.purpose).toBe('draftGeneration');
    expect(promptRecord.payload.editedByUser).toBe(true);
    expect(promptRecord.payload.editWarningAcknowledgedAt).toBeDefined();
    expect(promptRecord.payload.upstream).toEqual({
      promptInputFingerprint: promptRecord.payload.upstream.currentInputFingerprint,
      currentInputFingerprint: promptRecord.payload.upstream.currentInputFingerprint,
      staleResolution: 'current',
    });
    const actualPrompt = await readFile(
      path.join(projectRoot, promptRecord.payload.messages[0]!.contentRef.relativePath),
      'utf8',
    );
    expect(actualPrompt).toBe(editorFinalText);
  } finally {
    await electronApp.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('automatically runs the AI review pass before saving the version', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nw-controlled-review-'));
  const userData = path.join(root, 'user-data');
  const projectRoot = path.join(root, 'project');
  const minutes = await readFile(
    path.join(repositoryRoot, 'tests', 'fixtures', 'minutes', 'gf-01-official-complete.md'),
    'utf8',
  );
  const articles = [
    '初稿标题\n\n2099年4月12日，学院在教学楼A101举办信息核验工作坊。',
    '二次审稿标题\n\n2099年4月12日，学院在教学楼A101举办信息核验工作坊。',
  ];
  const electronApp = await electron.launch({
    executablePath: electronExecutablePath,
    args: [e2eMain, `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      NW_CONTROLLED_AI_E2E: 'news-writer-controlled-ai-e2e-v1',
      NW_CONTROLLED_AI_PLAN: JSON.stringify({
        schema: 'news-writer-controlled-ai-plan-v1',
        steps: articles.map((content, index) => ({
          type: 'success',
          content,
          completionId: `synthetic-review-completion-${index + 1}`,
          requestingAfterMs: 10,
          processingAfterMs: 10,
          settleAfterMs: 20,
        })),
      }),
    },
  });

  try {
    await electronApp.evaluate(({ dialog }, target) => {
      const mutableDialog = dialog as unknown as {
        showSaveDialog: () => Promise<{ canceled: boolean; filePath: string }>;
      };
      mutableDialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: target });
    }, projectRoot);
    const page = await electronApp.firstWindow();
    await page.getByRole('button', { name: /DeepSeek：未配置/ }).click();
    await page.getByLabel('API Key').fill('synthetic-review-key');
    await page.getByRole('button', { name: '保存' }).click();
    await page.getByRole('button', { name: /新建项目/ }).click();
    await page.getByLabel('项目名称').fill('AI 二次审稿自动执行');
    await page.getByRole('button', { name: '选择目录并创建' }).click();
    await page.locator('[data-testid="monaco-左侧编辑器"] .view-lines').click();
    await page.keyboard.insertText(minutes);
    await page.keyboard.press('Control+S');
    await expect(page.getByText('项目内容已同步')).toBeVisible();

    await page.getByRole('checkbox', { name: 'AI 二次审稿' }).check();
    await page.getByRole('button', { name: '准备初稿 Prompt' }).click();
    await page.getByRole('button', { name: '生成新版本' }).click();
    const acceptRisk = async (): Promise<void> => {
      const dialog = page.getByRole('dialog', { name: '确认生成风险' });
      if (await dialog.isVisible()) {
        await dialog.getByRole('button', { name: '已了解并继续' }).click();
      }
    };
    await acceptRisk();
    await waitForVersionCount(projectRoot, 1);
    await expect(page.locator('.task-summary strong')).toHaveText('已完成', { timeout: 10_000 });

    const head = await readHead(projectRoot);
    expect(head.state.tasks).toHaveLength(1);
    expect(head.state.prompts).toHaveLength(1);
    expect(head.state.versions).toHaveLength(1);
    const versionIds = head.state.versions.map((item) => item.entityId);
    expect(head.state.latestVersionId).toBe(versionIds[0]);

    const readTask = async (index: number) =>
      JSON.parse(
        await readFile(path.join(projectRoot, head.state.tasks[index]!.relativePath), 'utf8'),
      ) as {
        payload: {
          id: string;
          kind: string;
          status: string;
          parentVersionId: string | null;
          promptId: string;
          history: Array<{ status: string }>;
          resultVersionId?: string;
        };
      };
    const reviewTask = await readTask(0);
    expect(reviewTask.payload).toMatchObject({
      kind: 'draftGeneration',
      status: 'succeeded',
      parentVersionId: null,
      resultVersionId: versionIds[0],
    });
    expect(reviewTask.payload.history.map((entry) => entry.status)).toContain('reviewing');

    for (const [task, versionIndex] of [[reviewTask, 0]] as const) {
      const promptRef = head.state.prompts.find(
        (candidate) => candidate.entityId === task.payload.promptId,
      );
      expect(promptRef).toBeDefined();
      const promptRecord = JSON.parse(
        await readFile(path.join(projectRoot, promptRef!.relativePath), 'utf8'),
      ) as { payload: { messages: Array<{ contentRef: { relativePath: string } }> } };
      const prompt = await readFile(
        path.join(projectRoot, promptRecord.payload.messages[0]!.contentRef.relativePath),
        'utf8',
      );
      expect(prompt).toContain('活动纪要');
      const versionRecord = JSON.parse(
        await readFile(
          path.join(projectRoot, head.state.versions[versionIndex]!.relativePath),
          'utf8',
        ),
      ) as {
        payload: {
          parentVersionId: string | null;
          sourcePromptId: string;
          taskId: string;
          createdBy: string;
        };
      };
      expect(versionRecord.payload).toMatchObject({
        parentVersionId: null,
        sourcePromptId: task.payload.promptId,
        taskId: task.payload.id,
        createdBy: 'draftGeneration',
      });
    }
  } finally {
    await electronApp.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('resumes an active task after renderer reload without consuming another step', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nw-controlled-reload-'));
  const userData = path.join(root, 'user-data');
  const projectRoot = path.join(root, 'project');
  const minutes = await readFile(
    path.join(repositoryRoot, 'tests', 'fixtures', 'minutes', 'gf-01-official-complete.md'),
    'utf8',
  );
  const article = '活动任务恢复测试稿\n\n2099年4月12日，学院在教学楼A101举办信息核验工作坊。';
  const electronApp = await electron.launch({
    executablePath: electronExecutablePath,
    args: [e2eMain, `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      NW_CONTROLLED_AI_E2E: 'news-writer-controlled-ai-e2e-v1',
      NW_CONTROLLED_AI_PLAN: JSON.stringify({
        schema: 'news-writer-controlled-ai-plan-v1',
        steps: [
          {
            type: 'delayedSuccess',
            content: article,
            completionId: 'synthetic-completion-reload-1',
            requestingAfterMs: 50,
            processingAfterMs: 50,
            settleAfterMs: 1_200,
          },
        ],
      }),
    },
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
    await page.getByLabel('API Key').fill('synthetic-reload-key');
    await page.getByRole('button', { name: '保存' }).click();
    await page.getByRole('button', { name: /新建项目/ }).click();
    await page.getByLabel('项目名称').fill('活动任务 reload');
    await page.getByRole('button', { name: '选择目录并创建' }).click();
    await page.locator('[data-testid="monaco-左侧编辑器"] .view-lines').click();
    await page.keyboard.insertText(minutes);
    await page.keyboard.press('Control+S');
    await expect(page.getByText('项目内容已同步')).toBeVisible();
    await page.getByRole('button', { name: '准备初稿 Prompt' }).click();
    await page.getByRole('button', { name: '生成新版本' }).click();
    const riskDialog = page.getByRole('dialog', { name: '确认生成风险' });
    if (await riskDialog.isVisible()) {
      await riskDialog.getByRole('button', { name: '已了解并继续' }).click();
    }
    await expect(page.locator('.task-summary strong')).toHaveText('AI 正在处理');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.workspace')).toBeVisible();
    await expect(page.getByText('活动任务 reload', { exact: true })).toBeVisible();
    await expect(page.locator('.task-summary strong')).toHaveText('已完成', { timeout: 10_000 });
    await expect(page.getByText('活动任务恢复测试稿', { exact: true })).toBeVisible();

    const head = projectHeadV1Schema.parse(
      JSON.parse(await readFile(path.join(projectRoot, 'project.json'), 'utf8')),
    );
    expect(head.state.tasks).toHaveLength(1);
    expect(head.state.versions).toHaveLength(1);
    expect(head.state.latestVersionId).toBe(head.state.versions[0]!.entityId);
  } finally {
    await electronApp.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('does not create versions for failure, empty, invalid, timeout, or cancellation', async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'nw-controlled-failures-'));
  const userData = path.join(root, 'user-data');
  const projectRoot = path.join(root, 'project');
  const minutes = await readFile(
    path.join(repositoryRoot, 'tests', 'fixtures', 'minutes', 'gf-01-official-complete.md'),
    'utf8',
  );
  const timing = { requestingAfterMs: 10, processingAfterMs: 10, settleAfterMs: 20 };
  const electronApp = await electron.launch({
    executablePath: electronExecutablePath,
    args: [e2eMain, `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      NW_CONTROLLED_AI_E2E: 'news-writer-controlled-ai-e2e-v1',
      NW_CONTROLLED_AI_PLAN: JSON.stringify({
        schema: 'news-writer-controlled-ai-plan-v1',
        steps: [
          { type: 'safeFailure', code: 'SERVICE_UNAVAILABLE', ...timing },
          { type: 'empty', ...timing },
          { type: 'invalidContent', ...timing },
          { type: 'hang', ...timing },
          {
            type: 'delayedSuccess',
            content: '这篇稿件不应被保存。',
            completionId: 'synthetic-completion-cancelled',
            requestingAfterMs: 10,
            processingAfterMs: 10,
            settleAfterMs: 5_000,
          },
        ],
      }),
    },
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
    await page.getByLabel('API Key').fill('synthetic-failure-key');
    await page.getByRole('button', { name: '保存' }).click();
    await page.getByRole('button', { name: /新建项目/ }).click();
    await page.getByLabel('项目名称').fill('异常不造版');
    await page.getByRole('button', { name: '选择目录并创建' }).click();
    await page.locator('[data-testid="monaco-左侧编辑器"] .view-lines').click();
    await page.keyboard.insertText(minutes);
    await page.keyboard.press('Control+S');
    await expect(page.getByText('项目内容已同步')).toBeVisible();
    await page.getByRole('button', { name: /高级设置/ }).click();
    await page.getByLabel('超时（秒）').fill('10');
    await page.getByRole('button', { name: '保存单次配置' }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '准备初稿 Prompt' }).click();

    const persistedTaskCount = async (): Promise<number> => {
      const head = projectHeadV1Schema.parse(
        JSON.parse(await readFile(path.join(projectRoot, 'project.json'), 'utf8')),
      );
      return head.state.tasks.length;
    };
    const persistedLatestTaskStatus = async (): Promise<string> => {
      const head = projectHeadV1Schema.parse(
        JSON.parse(await readFile(path.join(projectRoot, 'project.json'), 'utf8')),
      );
      const taskRef = head.state.tasks.at(-1);
      if (!taskRef) return 'none';
      const record = JSON.parse(
        await readFile(path.join(projectRoot, taskRef.relativePath), 'utf8'),
      ) as { payload: { status: string } };
      return record.payload.status;
    };

    const acceptDuplicate = async (): Promise<void> => {
      const dialog = page.getByRole('dialog', { name: 'Prompt 未发生变化' });
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        if (await dialog.isVisible()) {
          await dialog.getByRole('button', { name: '仍然发送' }).click();
          return;
        }
        await page.waitForTimeout(100);
      }
    };

    const acceptRisk = async (): Promise<void> => {
      const dialog = page.getByRole('dialog', { name: '确认生成风险' });
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        if (await dialog.isVisible()) {
          await dialog.getByRole('button', { name: '已了解并继续' }).click();
          return;
        }
        await page.waitForTimeout(100);
      }
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.getByRole('button', { name: '生成新版本' }).click();
      await acceptDuplicate();
      await acceptRisk();
      await expect.poll(persistedTaskCount).toBe(attempt + 1);
      await expect.poll(persistedLatestTaskStatus).toBe('failed');
      await expect(page.locator('.task-summary strong')).toHaveText('失败', { timeout: 10_000 });
      await expect(page.getByRole('button', { name: '生成新版本' })).toBeEnabled();
      if (attempt < 2) {
        await page.getByRole('button', { name: '准备初稿 Prompt' }).click();
      }
    }

    await page.getByRole('button', { name: /高级设置/ }).click();
    await page.getByLabel('超时（秒）').fill('1');
    await page.getByRole('button', { name: '保存单次配置' }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '准备初稿 Prompt' }).click();
    await expect(page.getByRole('button', { name: '发送当前 Prompt，生成新版本' })).toBeEnabled({
      timeout: 10_000,
    });
    await page.waitForTimeout(1_000);
    await page.getByRole('button', { name: '生成新版本' }).click();
    await acceptDuplicate();
    await acceptRisk();
    await expect.poll(persistedTaskCount, { timeout: 15_000 }).toBe(4);
    await expect.poll(persistedLatestTaskStatus, { timeout: 10_000 }).toBe('timedOut');
    await expect(page.locator('.task-summary strong')).toHaveText('已超时', { timeout: 10_000 });
    await page.getByRole('button', { name: /高级设置/ }).click();
    await page.getByLabel('超时（秒）').fill('10');
    await page.getByRole('button', { name: '保存单次配置' }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '准备初稿 Prompt' }).click();
    await expect(page.getByRole('button', { name: '发送当前 Prompt，生成新版本' })).toBeEnabled({
      timeout: 10_000,
    });
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: '生成新版本' }).click();
    await acceptDuplicate();
    await acceptRisk();
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 3_000 });
    await expect.poll(persistedTaskCount, { timeout: 15_000 }).toBe(5);
    await expect(page.locator('.task-summary strong')).toHaveText('AI 正在处理');
    await page.getByRole('button', { name: '取消任务' }).click();
    await expect(page.getByText('服务端可能继续处理并产生费用')).toBeVisible();
    await page.getByRole('button', { name: '停止等待' }).click();
    await expect.poll(persistedLatestTaskStatus).toBe('cancelled');
    await expect(page.locator('.task-summary strong')).toHaveText('已取消', { timeout: 10_000 });

    const head = projectHeadV1Schema.parse(
      JSON.parse(await readFile(path.join(projectRoot, 'project.json'), 'utf8')),
    );
    expect(head.state.versions).toHaveLength(0);
    expect(head.state.latestVersionId).toBeNull();
    expect(head.state.tasks).toHaveLength(5);
    const errors: string[] = [];
    for (const taskRef of head.state.tasks) {
      const record = JSON.parse(
        await readFile(path.join(projectRoot, taskRef.relativePath), 'utf8'),
      ) as { payload: { error?: { code?: string } } };
      errors.push(record.payload.error?.code ?? 'none');
    }
    expect(errors).toEqual([
      'SERVICE_UNAVAILABLE',
      'EMPTY_RESPONSE',
      'CONTENT_INVALID',
      'REQUEST_TIMEOUT',
      'REQUEST_CANCELLED',
    ]);
  } finally {
    await electronApp.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('supports the other profile and distinguishes unavailable retrieval without management UI', async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'nw-controlled-other-'));
  const userData = path.join(root, 'user-data');
  const projectRoot = path.join(root, 'project');
  const minutes = await readFile(
    path.join(
      repositoryRoot,
      'tests',
      'fixtures',
      'minutes',
      'gf-04-other-channel-material-priority.md',
    ),
    'utf8',
  );
  const article =
    '家庭节水观察活动开展\n\n2099年7月21日，青禾科普实践队在社区共享教室开展家庭节水观察活动。';
  const electronApp = await electron.launch({
    executablePath: electronExecutablePath,
    args: [e2eMain, `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      NW_CONTROLLED_AI_E2E: 'news-writer-controlled-ai-e2e-v1',
      NW_CONTROLLED_AI_PLAN: JSON.stringify({
        schema: 'news-writer-controlled-ai-plan-v1',
        steps: [
          {
            type: 'success',
            content: article,
            completionId: 'synthetic-other-completion-1',
            requestingAfterMs: 10,
            processingAfterMs: 10,
            settleAfterMs: 20,
          },
        ],
      }),
    },
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
    await page.getByLabel('API Key').fill('synthetic-other-key');
    await page.getByRole('button', { name: '保存' }).click();
    await page.getByRole('button', { name: /新建项目/ }).click();
    await page.getByLabel('项目名称').fill('其他新闻稿检索边界');
    await page.getByLabel('其他新闻稿').check();
    await page.getByRole('button', { name: '选择目录并创建' }).click();
    await expect(page.getByText('其他新闻稿', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '展开资源' }).click();
    await expect(page.getByRole('checkbox', { name: '参考稿检索' })).toBeChecked();
    expect(await page.getByText(/知识库管理|重建知识库|导入知识库/).count()).toBe(0);
    await page.getByRole('button', { name: '折叠资源' }).click();

    const editor = page.locator('[data-testid="monaco-左侧编辑器"] .view-lines');
    await editor.click();
    await page.keyboard.insertText(minutes);
    await page.keyboard.press('Control+S');
    await expect(page.getByText('项目内容已同步')).toBeVisible();
    await page.getByRole('button', { name: /高级设置/ }).click();
    await page.getByLabel('目标渠道').fill('实践队公众号');
    await page.getByRole('button', { name: '保存单次配置' }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '准备初稿 Prompt' }).click();
    await page.getByRole('button', { name: '生成新版本' }).click();
    const riskDialog = page.getByRole('dialog', { name: '确认生成风险' });
    if (await riskDialog.isVisible()) {
      await riskDialog.getByRole('button', { name: '已了解并继续' }).click();
    }
    await waitForVersionCount(projectRoot, 1);
    await expect(page.locator('.task-summary strong')).toHaveText('已完成', { timeout: 10_000 });

    const head = await readHead(projectRoot);
    expect(head.state.project.profile).toBe('other');
    expect(head.state.retrievalReports).toHaveLength(0);
    expect(head.state.prompts).toHaveLength(1);
    expect(head.state.tasks).toHaveLength(1);
    expect(head.state.versions).toHaveLength(1);
    const versionId = head.state.versions[0]!.entityId;
    expect(head.state.latestVersionId).toBe(versionId);
    const task = JSON.parse(
      await readFile(path.join(projectRoot, head.state.tasks[0]!.relativePath), 'utf8'),
    ) as {
      payload: {
        id: string;
        kind: string;
        status: string;
        parentVersionId: string | null;
        promptId: string;
        resultVersionId?: string;
        configSnapshot: {
          profile: string;
          values: { targetChannel: string };
          sources: { targetChannel: string };
        };
      };
    };
    expect(task.payload).toMatchObject({
      kind: 'draftGeneration',
      status: 'succeeded',
      parentVersionId: null,
      resultVersionId: versionId,
      configSnapshot: {
        profile: 'other',
        values: { targetChannel: '实践队公众号' },
        sources: { targetChannel: 'task' },
      },
    });
    const promptRecord = JSON.parse(
      await readFile(path.join(projectRoot, head.state.prompts[0]!.relativePath), 'utf8'),
    ) as {
      payload: {
        id: string;
        purpose: string;
        messages: Array<{ contentRef: { relativePath: string } }>;
      };
    };
    expect(promptRecord.payload.id).toBe(task.payload.promptId);
    expect(promptRecord.payload.purpose).toBe('draftGeneration');
    const actualPrompt = await readFile(
      path.join(projectRoot, promptRecord.payload.messages[0]!.contentRef.relativePath),
      'utf8',
    );
    expect(actualPrompt).toContain('场景类型：other');
    expect(actualPrompt).toContain('发布/落款主体：青禾科普实践队');
    expect(actualPrompt).toContain('目标渠道：实践队公众号');
    expect(actualPrompt).toContain('不得默认套用示例学院的主体');
    expect(actualPrompt).not.toContain('发布/落款主体：示例学院');
    expect(actualPrompt).not.toContain('根据活动纪要撰写一篇学院官方新闻稿。');
    const version = JSON.parse(
      await readFile(path.join(projectRoot, head.state.versions[0]!.relativePath), 'utf8'),
    ) as {
      payload: {
        id: string;
        parentVersionId: string | null;
        sourcePromptId: string;
        taskId: string;
        createdBy: string;
      };
    };
    expect(version.payload).toMatchObject({
      id: versionId,
      parentVersionId: null,
      sourcePromptId: promptRecord.payload.id,
      taskId: task.payload.id,
      createdBy: 'draftGeneration',
    });
  } finally {
    await electronApp.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('snapshots latest-version comments into revision Prompt without inheriting them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nw-controlled-comments-'));
  const userData = path.join(root, 'user-data');
  const projectRoot = path.join(root, 'project');
  const minutes = await readFile(
    path.join(repositoryRoot, 'tests', 'fixtures', 'minutes', 'gf-01-official-complete.md'),
    'utf8',
  );
  const firstArticle = '初稿标题\n\n2099年4月12日，学院在教学楼A101举办信息核验工作坊。';
  const revisedArticle = '修改后标题\n\n2099年4月12日，学院在教学楼A101举办信息核验工作坊。';
  const electronApp = await electron.launch({
    executablePath: electronExecutablePath,
    args: [e2eMain, `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      NW_CONTROLLED_AI_E2E: 'news-writer-controlled-ai-e2e-v1',
      NW_CONTROLLED_AI_PLAN: JSON.stringify({
        schema: 'news-writer-controlled-ai-plan-v1',
        steps: [firstArticle, revisedArticle].map((content, index) => ({
          type: 'success',
          content,
          completionId: `synthetic-comment-completion-${index + 1}`,
          requestingAfterMs: 10,
          processingAfterMs: 10,
          settleAfterMs: 20,
        })),
      }),
    },
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
    await page.getByLabel('API Key').fill('synthetic-comment-key');
    await page.getByRole('button', { name: '保存' }).click();
    await page.getByRole('button', { name: /新建项目/ }).click();
    await page.getByLabel('项目名称').fill('批注续改流程');
    await page.getByRole('button', { name: '选择目录并创建' }).click();
    await page.locator('[data-testid="monaco-左侧编辑器"] .view-lines').click();
    await page.keyboard.insertText(minutes);
    await page.keyboard.press('Control+S');
    await expect(page.getByText('项目内容已同步')).toBeVisible();
    await page.getByRole('button', { name: '准备初稿 Prompt' }).click();
    await page.getByRole('button', { name: '生成新版本' }).click();
    const riskDialog = page.getByRole('dialog', { name: '确认生成风险' });
    if (await riskDialog.isVisible()) {
      await riskDialog.getByRole('button', { name: '已了解并继续' }).click();
    }
    await expect(page.locator('.task-summary strong')).toHaveText('已完成', { timeout: 10_000 });

    const latestEditor = page.locator('[data-testid="monaco-最新版编辑器"] .view-lines');
    await latestEditor.click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Shift+End');
    await expect(page.getByRole('button', { name: '为所选文本添加批注' })).toBeEnabled();
    await page.getByRole('button', { name: '为所选文本添加批注' }).click();
    await page.getByLabel('修订意见').fill('标题应突出工作坊主题');
    await page.getByRole('button', { name: '保存批注' }).click();
    await expect(page.getByText('标题应突出工作坊主题')).toBeVisible();

    await page.getByRole('button', { name: '按照批注更新 Prompt' }).click();
    await expect(page.locator('[data-testid="monaco-左侧编辑器"]')).toContainText(
      '根据当前版本的批注修订新闻稿',
    );
    await page.getByRole('button', { name: '生成新版本' }).click();
    await expect
      .poll(async () => {
        const current = projectHeadV1Schema.parse(
          JSON.parse(await readFile(path.join(projectRoot, 'project.json'), 'utf8')),
        );
        return current.state.tasks.length;
      })
      .toBe(2);
    await expect
      .poll(async () => {
        const current = projectHeadV1Schema.parse(
          JSON.parse(await readFile(path.join(projectRoot, 'project.json'), 'utf8')),
        );
        return current.state.versions.length;
      })
      .toBe(2);
    await expect(page.locator('.task-summary strong')).toHaveText('已完成', { timeout: 10_000 });

    const head = projectHeadV1Schema.parse(
      JSON.parse(await readFile(path.join(projectRoot, 'project.json'), 'utf8')),
    );
    expect(head.state.tasks).toHaveLength(2);
    expect(head.state.versions).toHaveLength(2);
    expect(head.state.comments).toHaveLength(1);
    const firstVersionId = head.state.versions[0]!.entityId;
    const secondVersionId = head.state.versions[1]!.entityId;
    expect(head.state.latestVersionId).toBe(secondVersionId);

    const commentRecord = JSON.parse(
      await readFile(path.join(projectRoot, head.state.comments[0]!.relativePath), 'utf8'),
    ) as { payload: { versionId: string } };
    expect(commentRecord.payload.versionId).toBe(firstVersionId);
    const revisionTask = JSON.parse(
      await readFile(path.join(projectRoot, head.state.tasks[1]!.relativePath), 'utf8'),
    ) as { payload: { parentVersionId: string; promptId: string; commentSnapshot: unknown[] } };
    expect(revisionTask.payload.parentVersionId).toBe(firstVersionId);
    expect(revisionTask.payload.commentSnapshot).toHaveLength(1);
    const promptRef = head.state.prompts.find(
      (candidate) => candidate.entityId === revisionTask.payload.promptId,
    );
    expect(promptRef).toBeDefined();
    const promptRecord = JSON.parse(
      await readFile(path.join(projectRoot, promptRef!.relativePath), 'utf8'),
    ) as { payload: { messages: Array<{ contentRef: { relativePath: string } }> } };
    const actualPrompt = await readFile(
      path.join(projectRoot, promptRecord.payload.messages[0]!.contentRef.relativePath),
      'utf8',
    );
    expect(actualPrompt).toContain('标题应突出工作坊主题');
  } finally {
    await electronApp.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('branches from a restored historical latest and can restore the original chain', async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'nw-controlled-branch-'));
  const userData = path.join(root, 'user-data');
  const projectRoot = path.join(root, 'project');
  const minutes = await readFile(
    path.join(repositoryRoot, 'tests', 'fixtures', 'minutes', 'gf-01-official-complete.md'),
    'utf8',
  );
  const articles = [
    '分支初稿\n\n2099年4月12日，学院在教学楼A101举办工作坊。',
    '原有效链第二稿\n\n2099年4月12日，学院在教学楼A101举办工作坊。',
    '从第一稿分出的第三稿\n\n2099年4月12日，学院在教学楼A101举办工作坊。',
  ];
  const electronApp = await electron.launch({
    executablePath: electronExecutablePath,
    args: [e2eMain, `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      NW_CONTROLLED_AI_E2E: 'news-writer-controlled-ai-e2e-v1',
      NW_CONTROLLED_AI_PLAN: JSON.stringify({
        schema: 'news-writer-controlled-ai-plan-v1',
        steps: articles.map((content, index) => ({
          type: 'success',
          content,
          completionId: `synthetic-branch-completion-${index + 1}`,
          requestingAfterMs: 10,
          processingAfterMs: 10,
          settleAfterMs: 20,
        })),
      }),
    },
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
    await page.getByLabel('API Key').fill('synthetic-branch-key');
    await page.getByRole('button', { name: '保存' }).click();
    await page.getByRole('button', { name: /新建项目/ }).click();
    await page.getByLabel('项目名称').fill('版本分支流程');
    await page.getByRole('button', { name: '选择目录并创建' }).click();
    await page.locator('[data-testid="monaco-左侧编辑器"] .view-lines').click();
    await page.keyboard.insertText(minutes);
    await page.keyboard.press('Control+S');
    await expect(page.getByText('项目内容已同步')).toBeVisible();
    await page.getByRole('button', { name: '准备初稿 Prompt' }).click();
    await page.getByRole('button', { name: '生成新版本' }).click();
    const riskDialog = page.getByRole('dialog', { name: '确认生成风险' });
    if (await riskDialog.isVisible()) {
      await riskDialog.getByRole('button', { name: '已了解并继续' }).click();
    }
    await waitForVersionCount(projectRoot, 1);

    await page.locator('[data-testid="monaco-最新版编辑器"] .view-lines').click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Shift+End');
    await page.getByRole('button', { name: '为所选文本添加批注' }).click();
    await page.getByLabel('修订意见').fill('第一轮批注');
    await page.getByRole('button', { name: '保存批注' }).click();
    await page.getByRole('button', { name: '按照批注更新 Prompt' }).click();
    await expect(page.locator('[data-testid="monaco-左侧编辑器"]')).toContainText(
      '根据当前版本的批注修订新闻稿',
    );
    await page.getByRole('button', { name: '生成新版本' }).click();
    await waitForVersionCount(projectRoot, 2);
    await expect(page.locator('.task-summary strong')).toHaveText('已完成', { timeout: 10_000 });
    const originalChainHead = await readHead(projectRoot);
    const version1 = originalChainHead.state.versions[0]!.entityId;
    const version2 = originalChainHead.state.versions[1]!.entityId;

    await page.getByRole('button', { name: '展开资源' }).click();
    const firstVersion = page.locator('.version-explorer li').nth(0);
    await firstVersion.getByRole('button').first().click();
    await expect(firstVersion.locator('.inline-command')).toBeVisible({ timeout: 5_000 });
    await firstVersion.locator('.inline-command').click();
    await page
      .getByRole('dialog', { name: '设为最新版' })
      .getByRole('button', {
        name: '确认设为最新版',
      })
      .click();
    await expect(page.getByRole('dialog', { name: '设为最新版' })).toBeHidden();
    await page.getByRole('button', { name: '折叠资源' }).click();
    await expect
      .poll(async () => (await readHead(projectRoot)).state.latestVersionId)
      .toBe(version1);
    const railToggle = page.getByRole('button', { name: '折叠资源' });
    if (await railToggle.isVisible()) await railToggle.click();
    await page.getByRole('button', { name: '编辑批注' }).click();
    await page.getByLabel('修订意见').fill('回溯后修改的批注');
    await page.getByRole('button', { name: '保存批注' }).click();
    await page.getByRole('button', { name: '按照批注更新 Prompt' }).click();
    await expect(page.locator('[data-testid="monaco-左侧编辑器"]')).toContainText(
      '根据当前版本的批注修订新闻稿',
    );
    await page.getByRole('button', { name: '生成新版本' }).click();
    await waitForVersionCount(projectRoot, 3);
    await expect(page.locator('.task-summary strong')).toHaveText('已完成', { timeout: 10_000 });
    const branched = await readHead(projectRoot);
    const version3 = branched.state.versions[2]!.entityId;
    const version2Record = JSON.parse(
      await readFile(path.join(projectRoot, branched.state.versions[1]!.relativePath), 'utf8'),
    ) as { payload: { parentVersionId: string } };
    const version3Record = JSON.parse(
      await readFile(path.join(projectRoot, branched.state.versions[2]!.relativePath), 'utf8'),
    ) as { payload: { parentVersionId: string } };
    expect(version2Record.payload.parentVersionId).toBe(version1);
    expect(version3Record.payload.parentVersionId).toBe(version1);
    expect(branched.state.latestVersionId).toBe(version3);

    const branchRailToggle = page.getByRole('button', { name: /展开资源|折叠资源/ });
    if ((await branchRailToggle.getAttribute('aria-label')) === '展开资源') {
      await branchRailToggle.click();
    }
    const secondVersion = page.locator('.version-explorer li').nth(1);
    await secondVersion.getByRole('button').first().click();
    await page.locator('.version-explorer .inline-command').click();
    await page
      .getByRole('dialog', { name: '设为最新版' })
      .getByRole('button', {
        name: '确认设为最新版',
      })
      .click();
    await expect
      .poll(async () => (await readHead(projectRoot)).state.latestVersionId)
      .toBe(version2);
    expect((await readHead(projectRoot)).state.versions).toHaveLength(3);
    await expect(page.getByText('当前最新版：第 2 版')).toBeVisible();
    const finalRailToggle = page.getByRole('button', { name: /展开资源|折叠资源/ });
    if ((await finalRailToggle.getAttribute('aria-label')) === '展开资源') {
      await finalRailToggle.click();
    }
    await page.getByRole('button', { name: /^第 3 版 / }).click();
    await page.getByRole('button', { name: '与最新版比较' }).click();
    await expect(page.locator('.monaco-diff-editor')).toBeVisible();
  } finally {
    await electronApp.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves drafts on CAS conflict and enforces active close, archive, and corrupt auth states', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nw-controlled-state-'));
  const userData = path.join(root, 'user-data');
  const projectRoot = path.join(root, 'project');
  const minutes = await readFile(
    path.join(repositoryRoot, 'tests', 'fixtures', 'minutes', 'gf-01-official-complete.md'),
    'utf8',
  );
  const electronApp = await electron.launch({
    executablePath: electronExecutablePath,
    args: [e2eMain, `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      NW_CONTROLLED_AI_E2E: 'news-writer-controlled-ai-e2e-v1',
      NW_CONTROLLED_AI_PLAN: JSON.stringify({
        schema: 'news-writer-controlled-ai-plan-v1',
        steps: [
          {
            type: 'delayedSuccess',
            content: '状态流程稿\n\n2099年4月12日，学院举办信息核验工作坊。',
            completionId: 'synthetic-state-completion',
            requestingAfterMs: 20,
            processingAfterMs: 20,
            settleAfterMs: 5_000,
          },
        ],
      }),
    },
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
    await page.getByLabel('API Key').fill('synthetic-state-key');
    await page.getByRole('button', { name: '保存' }).click();
    await page.getByRole('button', { name: /新建项目/ }).click();
    await page.getByLabel('项目名称').fill('状态与冲突流程');
    await page.getByRole('button', { name: '选择目录并创建' }).click();
    const minutesEditor = page.locator('[data-testid="monaco-左侧编辑器"] .view-lines');
    await minutesEditor.click();
    await page.keyboard.insertText(minutes);
    await page.keyboard.press('Control+S');
    await expect(page.getByText('项目内容已同步')).toBeVisible();

    await minutesEditor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n本地未保存草稿');
    await page.evaluate(async () => {
      const api = (
        globalThis as unknown as {
          newsWriter: {
            projects: {
              resumeOwned(): Promise<{
                ok: boolean;
                data?: { state: string; project?: { sessionId: string; revision: number } };
              }>;
              updateConfig(input: {
                sessionId: string;
                expectedRevision: number;
                config: { targetChannel: string };
              }): Promise<unknown>;
            };
          };
        }
      ).newsWriter;
      const resumed = await api.projects.resumeOwned();
      if (!resumed.ok || resumed.data?.state !== 'resumed' || !resumed.data.project) {
        throw new Error('Expected owner project.');
      }
      await api.projects.updateConfig({
        sessionId: resumed.data.project.sessionId,
        expectedRevision: resumed.data.project.revision,
        config: { targetChannel: '并发更新渠道' },
      });
    });
    await page.keyboard.press('Control+S');
    await expect(page.locator('.error-banner')).toBeVisible();
    await expect(page.locator('[data-testid="monaco-左侧编辑器"]')).toContainText('本地未保存草稿');
    await page.keyboard.press('Control+S');
    await expect(page.getByText('项目内容已同步')).toBeVisible();

    await page.getByRole('button', { name: '准备初稿 Prompt' }).click();
    await page.getByRole('button', { name: '生成新版本' }).click();
    const riskDialog = page.getByRole('dialog', { name: '确认生成风险' });
    if (await riskDialog.isVisible()) {
      await riskDialog.getByRole('button', { name: '已了解并继续' }).click();
    }
    await expect(page.locator('.task-summary strong')).toHaveText('AI 正在处理');
    await page.getByRole('button', { name: '文件' }).click();
    await page.getByRole('menuitem', { name: '关闭项目' }).click();
    await expect(page.getByRole('dialog', { name: '任务仍在进行' })).toBeVisible();
    await page.getByRole('button', { name: '知道了' }).click();
    await expect(page.locator('.workspace')).toBeVisible();
    await page.getByRole('button', { name: '取消任务' }).click();
    await page.getByRole('button', { name: '停止等待' }).click();
    await expect(page.locator('.task-summary strong')).toHaveText('已取消', { timeout: 10_000 });

    await page.getByRole('button', { name: '项目' }).click();
    await page.getByRole('menuitem', { name: '归档或恢复项目' }).click();
    await page
      .getByRole('dialog', { name: '归档项目' })
      .getByRole('button', {
        name: '确认归档',
      })
      .click();
    await expect(page.getByText('已归档', { exact: true })).toBeVisible();
    expect((await readHead(projectRoot)).state.project.status).toBe('archived');
    await page.getByRole('button', { name: '项目' }).click();
    await page.getByRole('menuitem', { name: '归档或恢复项目' }).click();
    await expect(page.getByText('已归档', { exact: true })).toBeHidden();
    expect((await readHead(projectRoot)).state.project.status).toBe('active');

    await page.getByRole('button', { name: '文件' }).click();
    await page.getByRole('menuitem', { name: '关闭项目' }).click();
    await expect(page.getByRole('heading', { name: 'News Writer' })).toBeVisible();

    await import('node:fs/promises').then(
      async ({ writeFile }) =>
        await writeFile(path.join(userData, 'auth.json'), '{invalid-json', 'utf8'),
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: /凭据损坏/ })).toBeVisible();
  } finally {
    await electronApp.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('requires explicit stale-lock recovery and supports both cancel and confirm', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nw-controlled-lock-'));
  const userData = path.join(root, 'user-data');
  const projectRoot = path.join(root, 'project');
  const electronApp = await electron.launch({
    executablePath: electronExecutablePath,
    args: [e2eMain, `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      NW_CONTROLLED_AI_E2E: 'news-writer-controlled-ai-e2e-v1',
      NW_CONTROLLED_AI_PLAN: JSON.stringify({
        schema: 'news-writer-controlled-ai-plan-v1',
        steps: [{ type: 'hang', requestingAfterMs: 0, processingAfterMs: 0, settleAfterMs: 0 }],
      }),
    },
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
    await page.getByRole('button', { name: /新建项目/ }).click();
    await page.getByLabel('项目名称').fill('过期锁恢复');
    await page.getByRole('button', { name: '选择目录并创建' }).click();
    await page.getByRole('button', { name: '文件' }).click();
    await page.getByRole('menuitem', { name: '关闭项目' }).click();
    await expect(page.getByRole('button', { name: /打开项目/ })).toBeVisible();

    const staleAt = '2000-01-01T00:00:00.000Z';
    const observedInstanceId = randomUUID();
    const lockRoot = path.join(projectRoot, '.news-writer', 'write.lock');
    await mkdir(lockRoot);
    await writeFile(
      path.join(lockRoot, 'owner.json'),
      serializeJson(
        lockOwnerV1Schema.parse({
          format: 'news-writer-lock-owner',
          storageVersion: 1,
          instanceId: observedInstanceId,
          pid: 2_147_483_647,
          processStartedAt: staleAt,
          appVersion: '0.1.0',
          heartbeatAt: staleAt,
        }),
      ),
    );
    await utimes(lockRoot, new Date(staleAt), new Date(staleAt));
    await electronApp.evaluate(({ dialog }, target) => {
      const mutableDialog = dialog as unknown as {
        showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>;
      };
      mutableDialog.showOpenDialog = () =>
        Promise.resolve({ canceled: false, filePaths: [target] });
    }, projectRoot);

    await page.getByRole('button', { name: /打开项目/ }).click();
    const recovery = page.getByRole('dialog', { name: '恢复项目锁' });
    await expect(recovery).toBeVisible();
    await expect(recovery.getByText(observedInstanceId)).toBeVisible();
    await recovery.getByRole('button', { name: '取消' }).click();
    await expect(page.getByRole('button', { name: /打开项目/ })).toBeVisible();

    await page.getByRole('button', { name: /打开项目/ }).click();
    await expect(recovery).toBeVisible();
    await recovery.getByRole('button', { name: '确认恢复' }).click();
    await expect(page.locator('.workspace')).toBeVisible();
    await expect(page.getByText('过期锁恢复', { exact: true })).toBeVisible();
  } finally {
    await electronApp.close();
    await rm(root, { recursive: true, force: true });
  }
});
