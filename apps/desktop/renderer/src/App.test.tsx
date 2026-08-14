import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AuthStatusDto,
  IpcResult,
  NewsWriterApiV1,
  ProjectViewDto,
} from '@news-writer/shared/ipc';

import { App } from './App';

vi.mock('./MonacoEditor', () => ({
  MonacoTextEditor: ({
    ariaLabel,
    value,
    onSelection,
  }: {
    ariaLabel: string;
    value: string;
    onSelection?: (selection: {
      start: number;
      end: number;
      exact: string;
      prefix: string;
      suffix: string;
    }) => void;
  }) => (
    <div data-testid={ariaLabel}>
      {value}
      {onSelection && (
        <button
          aria-label="模拟选择新引用"
          onClick={() =>
            onSelection({ start: 4, end: 7, exact: '新引用', prefix: '原引用 ', suffix: '' })
          }
        />
      )}
    </div>
  ),
  MonacoDiffEditor: () => <div data-testid="diff-editor">diff</div>,
}));

const ok = <T,>(data: T) => ({ protocolVersion: 1 as const, ok: true as const, data });
const failed = (code: 'AUTH_REJECTED'): IpcResult<AuthStatusDto> => ({
  protocolVersion: 1 as const,
  ok: false as const,
  error: {
    code,
    occurredAt: '2026-08-10T01:00:00.000000Z' as never,
    safeMessage: 'safe failure',
    retryable: false,
  },
});
const sessionId = '10000000-0000-4000-8000-000000000001';
const minuteId = '10000000-0000-4000-8000-000000000002';
const revisionId = '10000000-0000-4000-8000-000000000003';
const fingerprint = 'a'.repeat(64);

const view = {
  sessionId,
  revision: 0,
  projectId: '10000000-0000-4000-8000-000000000004',
  name: '计算机学院新闻稿',
  profile: 'official',
  status: 'active',
  createdAt: '2026-08-10T01:00:00.000000Z',
  updatedAt: '2026-08-10T01:00:00.000000Z',
  latestVersionId: null,
  projectConfig: {},
  minutes: {
    minuteId,
    revisionId,
    createdAt: '2026-08-10T01:00:00.000000Z',
    content: '活动于报告厅举行。',
  },
  versions: [],
  comments: [],
  prompts: [],
  tasks: [],
  retrievalReports: [],
  exportRecords: [],
} as unknown as ProjectViewDto;

const commentedView = {
  ...view,
  revision: 3,
  latestVersionId: '10000000-0000-4000-8000-000000000010',
  versions: [
    {
      id: '10000000-0000-4000-8000-000000000010',
      createdAt: '2026-08-10T01:00:01.000000Z',
      parentVersionId: null,
      createdBy: 'draftGeneration',
      taskId: '10000000-0000-4000-8000-000000000011',
      contentSha256: fingerprint,
      content: '原引用 新引用',
    },
  ],
  comments: [
    {
      id: '10000000-0000-4000-8000-000000000012',
      revision: 0,
      versionId: '10000000-0000-4000-8000-000000000010',
      anchor: {
        kind: 'textQuote',
        contentSha256: fingerprint,
        start: 0,
        end: 3,
        exact: '原引用',
        prefix: '',
        suffix: ' 新引用',
      },
      quotedText: '原引用',
      body: '原批注',
      createdAt: '2026-08-10T01:00:02.000000Z',
      updatedAt: '2026-08-10T01:00:02.000000Z',
    },
  ],
} as unknown as ProjectViewDto;

const api = () => ({
  runtime: {
    getInfo: vi.fn(async () =>
      ok({
        appVersion: '0.1.0',
        chromiumVersion: '136.0.0.0',
        electronVersion: '43.3.0',
        projectSchemaVersion: 1 as const,
        knowledgeVersion: null,
        platform: 'win32' as const,
        arch: 'x64' as const,
      }),
    ),
  },
  auth: {
    getStatus: vi.fn<() => Promise<IpcResult<AuthStatusDto>>>(async () =>
      ok({ provider: 'deepseek' as const, status: 'configured' as const }),
    ),
    setDeepSeekApiKey: vi.fn<(input: { apiKey: string }) => Promise<IpcResult<AuthStatusDto>>>(
      async () => ok({ provider: 'deepseek' as const, status: 'configured' as const }),
    ),
    clearDeepSeekApiKey: vi.fn<(input: { confirmed: true }) => Promise<IpcResult<AuthStatusDto>>>(
      async () => ok({ provider: 'deepseek' as const, status: 'notConfigured' as const }),
    ),
  },
  settings: {
    getUserConfig: vi.fn(async () => ok({ revision: 0, config: {} })),
    updateUserConfig: vi.fn(async () => ok({ revision: 1, config: {} })),
    previewConfig: vi.fn(async () =>
      ok({
        schemaVersion: 1 as const,
        provider: 'deepseek' as const,
        profile: 'official' as const,
        values: {
          model: 'deepseek-v4-pro',
          reasoningEffort: 'high' as const,
          targetChannel: '学院网站',
          maxWords: 800,
          requestTimeoutMs: 60_000,
        },
        sources: {
          model: 'default' as const,
          reasoningEffort: 'user' as const,
          targetChannel: 'project' as const,
          maxWords: 'task' as const,
          requestTimeoutMs: 'default' as const,
        },
      }),
    ),
  },
  projects: {
    createWithDialog: vi.fn(),
    openWithDialog: vi.fn(async () => ok({ cancelled: false as const, data: view })),
    resumeOwned: vi.fn(async () => ok({ state: 'none' as const })),
    recoverOpen: vi.fn(),
    close: vi.fn(async () => ok({ closed: true as const })),
    refresh: vi.fn(async () => ok(view)),
    saveMinutes: vi.fn(async () => ok(view)),
    importMinutesWithDialog: vi.fn(async () => ok({ cancelled: true as const })),
    updateConfig: vi.fn(async () => ok(view)),
    setArchived: vi.fn(async () => ok(view)),
    setLatestVersion: vi.fn(async () => ok(view)),
  },
  comments: {
    add: vi.fn<(input: unknown) => Promise<IpcResult<ProjectViewDto>>>(async () => ok(view)),
    edit: vi.fn<(input: unknown) => Promise<IpcResult<ProjectViewDto>>>(async () => ok(view)),
    delete: vi.fn<(input: unknown) => Promise<IpcResult<ProjectViewDto>>>(async () => ok(view)),
  },
  prompts: {
    prepare: vi.fn(async () =>
      ok({
        schemaVersion: 1 as const,
        purpose: 'draftGeneration' as const,
        messages: [{ role: 'user' as const, content: '受信任 Prompt' }],
        inputFingerprint: fingerprint,
        resolvedConfig: {
          schemaVersion: 1 as const,
          provider: 'deepseek' as const,
          profile: 'official' as const,
          values: {
            model: 'deepseek-v4-pro',
            reasoningEffort: 'high' as const,
            targetChannel: '学院网站',
            maxWords: 800,
            requestTimeoutMs: 60_000,
          },
          sources: {
            model: 'default' as const,
            reasoningEffort: 'default' as const,
            targetChannel: 'default' as const,
            maxWords: 'default' as const,
            requestTimeoutMs: 'default' as const,
          },
        },
        factCheck: {
          date: { status: 'present' as const, evidence: '今天', source: 'detected' as const },
          location: { status: 'present' as const, evidence: '报告厅', source: 'detected' as const },
          organizer: { status: 'present' as const, evidence: '学院', source: 'detected' as const },
          time: { status: 'present' as const, evidence: '上午', source: 'detected' as const },
          blocking: false,
        },
        risks: [],
        trace: {
          minutes: { revisionId, sha256: fingerprint },
          parent: null,
          retrieval: { state: 'notUsed' as const },
          comments: { count: 0, sha256: fingerprint },
          writingRulesVersion: 'prompt-contract-v1' as const,
        },
      }),
    ),
  },
  retrieval: { search: vi.fn() },
  tasks: {
    start: vi.fn(),
    cancel: vi.fn(),
    onStatus: vi.fn(() => () => undefined),
  },
  documents: {
    exportWithDialog: vi.fn<NewsWriterApiV1['documents']['exportWithDialog']>(async () =>
      ok({ cancelled: true as const }),
    ),
  },
});

describe('App', () => {
  let bridge: ReturnType<typeof api>;
  beforeEach(() => {
    bridge = api();
    Object.defineProperty(window, 'newsWriter', { configurable: true, value: bridge });
    Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => true) });
    Object.defineProperty(window, 'alert', { configurable: true, value: vi.fn() });
  });
  afterEach(cleanup);

  it('renders the usable welcome state and runtime versions', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'News Writer' })).toBeDefined();
    expect(screen.getByRole('button', { name: /新建项目/ })).toBeDefined();
    expect(screen.getByText(/Electron 43.3.0/)).toBeDefined();
  });

  it('opens the workspace with collapsed resources and comments visible', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /打开项目/ }));
    await waitFor(() => expect(bridge.settings.previewConfig).toHaveBeenCalled());
    expect(await screen.findByText('计算机学院新闻稿')).toBeDefined();
    expect(screen.getByRole('heading', { name: '批注' })).toBeDefined();
    const rail = document.querySelector('.resource-rail');
    expect(rail?.classList.contains('open')).toBe(false);
    expect(screen.getByTestId('左侧编辑器').textContent).toContain('报告厅');
  });

  it('shows safe export history for archived projects without exposing a path', async () => {
    const exportView = {
      ...commentedView,
      status: 'archived',
      archivedAt: '2026-08-10T03:00:00.000000Z',
      exportRecords: [
        {
          id: '10000000-0000-4000-8000-000000000020',
          versionId: commentedView.versions[0]!.id,
          attemptedAt: '2026-08-10T02:00:00.000000Z',
          completedAt: '2026-08-10T02:00:01.000000Z',
          fileName: '新闻稿.docx',
          status: 'succeeded',
          templateVersion: 'standard_business_brief.zh_news_a4.v1',
          outputSha256: fingerprint,
          byteLength: 8474,
        },
        {
          id: '10000000-0000-4000-8000-000000000021',
          versionId: commentedView.versions[0]!.id,
          attemptedAt: '2026-08-10T02:01:00.000000Z',
          completedAt: '2026-08-10T02:01:01.000000Z',
          fileName: '失败稿.docx',
          status: 'failed',
          templateVersion: 'standard_business_brief.zh_news_a4.v1',
          error: {
            code: 'EXPORT_IO_ERROR',
            occurredAt: '2026-08-10T02:01:01.000000Z',
            safeMessage: '安全导出错误',
            retryable: true,
          },
        },
      ],
    } as unknown as ProjectViewDto;
    bridge.projects.openWithDialog.mockResolvedValueOnce(
      ok({ cancelled: false as const, data: exportView }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /打开项目/ }));
    fireEvent.click(await screen.findByRole('button', { name: '展开资源' }));
    expect(await screen.findByRole('heading', { name: '导出记录' })).toBeDefined();
    expect(screen.getByText('新闻稿.docx')).toBeDefined();
    expect(screen.getByText('失败稿.docx')).toBeDefined();
    expect(screen.getByText('安全导出错误')).toBeDefined();
    expect(screen.getAllByText('第 1 版').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain('C:\\Users\\private');
    expect(screen.getByLabelText('导出所选版本为 DOCX')).not.toHaveProperty('disabled', true);
  });

  it('reports dialog cancellation without changing the project', async () => {
    bridge.projects.openWithDialog.mockResolvedValueOnce(
      ok({ cancelled: false as const, data: commentedView }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /打开项目/ }));
    fireEvent.click(await screen.findByLabelText('导出所选版本为 DOCX'));
    await waitFor(() => expect(bridge.documents.exportWithDialog).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('已取消导出')).toBeDefined();
  });

  it('shows a safe error when the export IPC action fails', async () => {
    bridge.projects.openWithDialog.mockResolvedValueOnce(
      ok({ cancelled: false as const, data: commentedView }),
    );
    bridge.documents.exportWithDialog.mockResolvedValueOnce({
      protocolVersion: 1,
      ok: false,
      error: {
        code: 'EXPORT_IO_ERROR',
        occurredAt: '2026-08-10T04:00:00.000000Z' as never,
        safeMessage: '不得显示的底层路径 C:\\Users\\private',
        retryable: true,
      },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /打开项目/ }));
    fireEvent.click(await screen.findByLabelText('导出所选版本为 DOCX'));
    expect(await screen.findByText(/DOCX 写入或校验失败，原有版本未受影响。/u)).toBeDefined();
    expect(document.body.textContent).not.toContain('C:\\Users\\private');
  });

  it('exports a selected historical version and projects the successful record', async () => {
    const firstId = '10000000-0000-4000-8000-000000000009';
    const historyView = {
      ...commentedView,
      revision: 4,
      versions: [
        { ...commentedView.versions[0]!, id: firstId, parentVersionId: null, content: '历史稿' },
        { ...commentedView.versions[0]!, parentVersionId: firstId },
      ],
      exportRecords: [],
    } as unknown as ProjectViewDto;
    const record = {
      id: '10000000-0000-4000-8000-000000000022',
      versionId: firstId,
      attemptedAt: '2026-08-10T04:00:00.000000Z',
      completedAt: '2026-08-10T04:00:01.000000Z',
      fileName: '历史稿.docx',
      status: 'succeeded',
      templateVersion: 'standard_business_brief.zh_news_a4.v1',
      outputSha256: fingerprint,
      byteLength: 8474,
    } as unknown as ProjectViewDto['exportRecords'][number];
    const resultView = {
      ...historyView,
      revision: 5,
      exportRecords: [record],
    };
    bridge.projects.openWithDialog.mockResolvedValueOnce(
      ok({ cancelled: false as const, data: historyView }),
    );
    bridge.documents.exportWithDialog.mockResolvedValueOnce(
      ok({ cancelled: false as const, project: resultView, record }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /打开项目/ }));
    fireEvent.click(await screen.findByRole('button', { name: '展开资源' }));
    const historicalButton = screen
      .getAllByRole('button')
      .find((button) => button.textContent?.trim().startsWith('第 1 版'));
    if (!historicalButton) throw new Error('historical version button missing');
    fireEvent.click(historicalButton);
    fireEvent.click(screen.getByLabelText('导出所选版本为 DOCX'));
    await waitFor(() =>
      expect(bridge.documents.exportWithDialog).toHaveBeenCalledWith(
        expect.objectContaining({ versionId: firstId }),
      ),
    );
    expect(await screen.findByText('已导出 历史稿.docx')).toBeDefined();
    expect(screen.getByText('历史稿.docx')).toBeDefined();
  });

  it('requires acknowledgement before the prepared Prompt becomes editable', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /打开项目/ }));
    fireEvent.click(await screen.findByRole('button', { name: '准备初稿 Prompt' }));
    await waitFor(() => expect(bridge.prompts.prepare).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('受信任 Prompt')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '编辑 Prompt' }));
    expect(screen.getByText(/修改可能破坏事实约束/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /我已了解/ }));
    expect(screen.queryByText(/修改可能破坏事实约束/)).toBeNull();
  });

  it('keeps the comment textarea focused while typing', async () => {
    bridge.projects.openWithDialog.mockResolvedValue(
      ok({ cancelled: false as const, data: commentedView }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /打开项目/ }));
    await waitFor(() => expect(bridge.settings.previewConfig).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: '模拟选择新引用' }));
    fireEvent.click(screen.getByRole('button', { name: '为所选文本添加批注' }));
    const commentInput = screen.getByLabelText<HTMLTextAreaElement>('批注正文');
    commentInput.focus();
    fireEvent.change(commentInput, { target: { value: '补' } });
    fireEvent.change(commentInput, { target: { value: '补充' } });
    expect(document.activeElement).toBe(commentInput);
    expect(commentInput.value).toBe('补充');
  });

  it('shows trusted resolved configuration sources and marks Prompt stale after task override', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /打开项目/ }));
    fireEvent.click(await screen.findByRole('button', { name: '准备初稿 Prompt' }));
    await screen.findByText('受信任 Prompt');
    fireEvent.click(screen.getByRole('button', { name: /高级设置/ }));
    expect(await screen.findByText('deepseek-v4-pro（默认）')).toBeDefined();
    expect(screen.getByText('high（用户）')).toBeDefined();
    expect(screen.getByText('学院网站（项目）')).toBeDefined();
    fireEvent.change(screen.getByLabelText('目标字数'), { target: { value: '900' } });
    fireEvent.click(screen.getByRole('button', { name: '保存单次配置' }));
    fireEvent.click(screen.getByRole('button', { name: '发送当前 Prompt，生成新版本' }));
    expect(await screen.findByRole('dialog', { name: 'Prompt 已过期' })).toBeDefined();
  });

  it('renders the structured fact check from Prompt preparation', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /打开项目/ }));
    fireEvent.click(await screen.findByRole('button', { name: '准备初稿 Prompt' }));
    const factCheck = await screen.findByRole('region', { name: '事实检查' });
    expect(factCheck.textContent).toContain('日期');
    expect(factCheck.textContent).toContain('时间');
    expect(factCheck.textContent).toContain('地点');
    expect(factCheck.textContent).toContain('举办单位');
    expect(factCheck.textContent).toContain('提示用于核对，不代表事实已经得到证明');
  });

  it('allows fact-check items to be confirmed manually or as unavailable and forwards overrides', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /打开项目/ }));
    fireEvent.click(await screen.findByRole('button', { name: '准备初稿 Prompt' }));
    const factCheck = await screen.findByRole('region', { name: '事实检查' });

    fireEvent.change(screen.getByLabelText('日期事实来源'), { target: { value: 'manual' } });
    const dateInput = screen.getByLabelText<HTMLInputElement>('日期手动值');
    fireEvent.change(dateInput, { target: { value: '2026年8月' } });
    expect(factCheck.textContent).toContain('手动值');
    expect(factCheck.textContent).toContain('用户确认：2026年8月');
    fireEvent.change(screen.getByLabelText('地点事实来源'), { target: { value: 'none' } });
    expect(factCheck.textContent).toContain('确认没有');

    fireEvent.click(screen.getByRole('button', { name: '准备初稿 Prompt' }));
    await waitFor(() => expect(bridge.prompts.prepare).toHaveBeenCalledTimes(2));
    const input = (
      bridge.prompts.prepare.mock.calls.at(-1) as unknown as [unknown] | undefined
    )?.[0] as {
      factOverrides?: {
        date?: { mode: string; value?: string };
        location?: { mode: string; value?: string };
      };
    };
    expect(input.factOverrides?.date).toEqual({ mode: 'manual', value: '2026年8月' });
    expect(input.factOverrides?.location).toEqual({ mode: 'none' });
  });

  it('distinguishes auth states and keeps a safe inline error while clearing the key field', async () => {
    bridge.auth.getStatus.mockResolvedValue(
      ok({ provider: 'deepseek' as const, status: 'unavailable' as const }),
    );
    bridge.auth.setDeepSeekApiKey.mockResolvedValue(failed('AUTH_REJECTED'));
    render(<App />);
    const authButton = await screen.findByRole('button', { name: /安全存储不可用/ });
    fireEvent.click(authButton);
    const key = screen.getByLabelText<HTMLInputElement>('API Key');
    fireEvent.change(key, { target: { value: 'temporary-key' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(key.value).toBe('');
    expect(screen.getByRole('dialog', { name: 'DeepSeek 认证' })).toBeDefined();
  });

  it('executes Ctrl+O and closes a menu with Escape', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /打开项目/ }));
    await waitFor(() => expect(bridge.settings.previewConfig).toHaveBeenCalled());
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    await waitFor(() => expect(bridge.projects.openWithDialog).toHaveBeenCalledTimes(2));
    expect(bridge.projects.close).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const item = screen.getByRole('menuitem', { name: /Tab 键/ });
    item.focus();
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '编辑' }));
  });

  it('preserves a comment anchor on body edit and only reanchors explicitly', async () => {
    bridge.projects.openWithDialog.mockResolvedValue(
      ok({ cancelled: false as const, data: commentedView }),
    );
    bridge.comments.edit.mockResolvedValue(ok(commentedView));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /打开项目/ }));
    fireEvent.click(await screen.findByRole('button', { name: '模拟选择新引用' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑批注' }));
    fireEvent.change(screen.getByLabelText('批注正文'), { target: { value: '只改正文' } });
    fireEvent.click(screen.getByRole('button', { name: '保存批注' }));
    await waitFor(() => expect(bridge.comments.edit).toHaveBeenCalledTimes(1));
    expect(bridge.comments.edit.mock.calls[0]?.[0]).toMatchObject({
      anchor: { exact: '原引用', start: 0, end: 3 },
      quotedText: '原引用',
      body: '只改正文',
    });

    fireEvent.click(screen.getByRole('button', { name: '模拟选择新引用' }));
    fireEvent.click(screen.getByRole('button', { name: '重新标定' }));
    fireEvent.click(screen.getByRole('button', { name: '确认重新标定' }));
    await waitFor(() => expect(bridge.comments.edit).toHaveBeenCalledTimes(2));
    expect(bridge.comments.edit.mock.calls[1]?.[0]).toMatchObject({
      anchor: { exact: '新引用', start: 4, end: 7 },
      quotedText: '新引用',
    });
  });

  it('deletes a misplaced latest-version comment after confirmation', async () => {
    bridge.projects.openWithDialog.mockResolvedValue(
      ok({ cancelled: false as const, data: commentedView }),
    );
    bridge.comments.delete.mockResolvedValue(ok({ ...commentedView, comments: [] }));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /打开项目/ }));
    await screen.findByRole('heading', { name: '批注' });
    fireEvent.click(screen.getByRole('button', { name: '删除批注' }));
    const confirmation = await screen.findByRole('dialog', { name: '删除批注' });
    expect(confirmation).toBeDefined();
    fireEvent.click(within(confirmation).getByRole('button', { name: '删除批注' }));
    await waitFor(() => expect(bridge.comments.delete).toHaveBeenCalledTimes(1));
    expect(bridge.comments.delete.mock.calls[0]?.[0]).toMatchObject({
      commentId: '10000000-0000-4000-8000-000000000012',
      expectedCommentRevision: 0,
    });
  });
});
