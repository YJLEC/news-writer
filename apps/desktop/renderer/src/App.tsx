import './app.css';

import {
  BookOpen,
  FilePlus2,
  Download,
  FolderOpen,
  GitCompare,
  KeyRound,
  MessageSquare,
  PanelLeft,
  Play,
  RotateCcw,
  Save,
  Settings,
  X,
} from 'lucide-react';
import { Component, useCallback, useEffect, useReducer, useRef, useState } from 'react';

import type {
  AuthStatusDto,
  ProjectLockRecoveryDescriptor,
  ProjectViewDto,
  ResolvedGenerationConfigDto,
  RuntimeInfoDto,
  TaskViewDto,
  UserConfigViewDto,
} from '@news-writer/shared/ipc';

import { MonacoDiffEditor, MonacoTextEditor } from './MonacoEditor';
import { MonacoDiagnostic } from './MonacoDiagnostic';
import {
  createWorkspaceState,
  isAnchorValid,
  projectVersions,
  workspaceReducer,
  type FactOverrideMode,
  type FactOverrides,
  type TextSelection,
} from './workspaceState';

type ConfigDraft = {
  model?: string | undefined;
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | undefined;
  targetChannel?: string | undefined;
  maxWords?: number | undefined;
  requestTimeoutMs?: number | undefined;
};

const taskLabels: Record<TaskViewDto['status'], string> = {
  queued: '已排队',
  preparing: '正在准备',
  requesting: '正在发送请求',
  processing: 'AI 正在处理',
  reviewing: 'AI 二次审稿',
  saving: '正在保存',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  timedOut: '已超时',
};

const countText = (value: string): number => Array.from(value.replace(/\s/g, '')).length;

const factOverrideFields = ['date', 'time', 'location', 'organizer'] as const;

const serializeFactOverrides = (overrides?: FactOverrides): FactOverrides | undefined => {
  if (!overrides) return undefined;
  const normalized = Object.fromEntries(
    factOverrideFields.flatMap((field) => {
      const item = overrides[field];
      if (item === undefined) return [];
      return [[field, item.mode === 'manual' && !item.value?.trim() ? { mode: 'auto' } : item]];
    }),
  ) as FactOverrides;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

const sourceLabels = { default: '默认', user: '用户', project: '项目', task: '单次' };
const authStatusLabels: Record<AuthStatusDto['status'], string> = {
  notConfigured: '未配置',
  configured: '已配置',
  unavailable: '安全存储不可用',
  corrupt: '凭据损坏',
};

interface IpcFailureDetail {
  code?: string;
  diagnosticId?: string;
  suggestedAction?: string;
}

class IpcFailure extends Error {
  readonly detail: IpcFailureDetail;
  constructor(detail: unknown) {
    super('Trusted desktop command failed');
    let code: unknown;
    let diagnosticId: unknown;
    let suggestedAction: unknown;
    if (typeof detail === 'object' && detail !== null) {
      if ('code' in detail) code = detail.code;
      if ('diagnosticId' in detail) diagnosticId = detail.diagnosticId;
      if ('suggestedAction' in detail) suggestedAction = detail.suggestedAction;
    }
    this.detail = {
      ...(typeof code === 'string' ? { code } : {}),
      ...(typeof diagnosticId === 'string' ? { diagnosticId } : {}),
      ...(typeof suggestedAction === 'string' ? { suggestedAction } : {}),
    };
  }
}

const errorMessage = (code: string): string => {
  const messages: Record<string, string> = {
    AUTH_REQUIRED: '请先配置 DeepSeek API Key。',
    PROJECT_CONFLICT: '项目已在磁盘上更新。已刷新权威内容，本地草稿仍保留。',
    PROJECT_STATE_CONFLICT: '项目状态发生变化。已刷新项目，本地草稿仍保留。',
    PROJECT_READ_ONLY: '归档项目为只读，请先恢复项目。',
    RESOURCE_UNAVAILABLE:
      '当前版本未携带已批准的内置参考资料。完成知识库审批并更新应用后，才能在 Prompt 中使用历史参考稿。',
    PROJECT_LOCKED: '项目正在另一窗口或进程中使用。',
    PROJECT_LOCK_RECOVERY_REQUIRED: '检测到过期项目锁，需要明确确认后才能恢复。',
    DOCUMENT_CONTENT_INVALID: '该版本缺少可导出的标题、正文、落款或有效日期。',
    DOCUMENT_GENERATION_FAILED: 'DOCX 生成失败，请重试。',
    EXPORT_PATH_INVALID: '导出位置无效，请重新选择。',
    EXPORT_NOT_WRITABLE: '导出位置不可写，请选择其他位置。',
    EXPORT_DISK_FULL: '磁盘空间不足，DOCX 未导出。',
    EXPORT_ATOMIC_REPLACE_FAILED: '目标文件正被占用，原文件保持不变。',
    EXPORT_IO_ERROR: 'DOCX 写入或校验失败，原有版本未受影响。',
  };
  return messages[code] ?? '操作未完成，请根据下方诊断编号重试或联系维护人员。';
};

const describeSafeError = (error: {
  code: string;
  safeMessage: string;
  diagnosticId?: string | undefined;
}): string =>
  `${errorMessage(error.code)} ${error.safeMessage}${error.diagnosticId ? ` 诊断编号：${error.diagnosticId}` : ''}`;

interface ModalProps {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  labelledBy?: string;
  className?: string;
}

const Modal = ({ title, children, onClose, className }: ModalProps): React.JSX.Element => {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Preserve an input's autoFocus. When a modal is mounted, React may have
    // already focused the first form control before this effect runs.
    if (!dialogRef.current?.contains(document.activeElement)) {
      const firstControl = dialogRef.current?.querySelector<HTMLElement>(
        'input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled):not([aria-label="关闭"]), [tabindex]:not([tabindex="-1"])',
      );
      (firstControl ?? closeRef.current)?.focus();
    }
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      }
      if (event.key === 'Tab' && dialogRef.current) {
        const focusable = [
          ...dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
          ),
        ];
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={className ? `modal ${className}` : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <header>
          <h2 id="modal-title">{title}</h2>
          <button
            ref={closeRef}
            className="icon-button"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
};

class ErrorBoundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <main className="fatal-view">
          <h1>News Writer</h1>
          <div role="alert">界面渲染失败。请关闭并重新打开应用；项目文件不会因此被覆盖。</div>
        </main>
      );
    }
    return this.props.children;
  }
}

const AuthDialog = ({
  status,
  onSet,
  onClear,
  onClose,
}: {
  status: AuthStatusDto;
  onSet: (value: string) => Promise<void>;
  onClear: () => Promise<void>;
  onClose: () => void;
}): React.JSX.Element => {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [confirmation, setConfirmation] = useState<'overwrite' | 'clear' | null>(null);
  const settleSet = async (): Promise<void> => {
    setBusy(true);
    setFailure('');
    try {
      await onSet(key);
    } catch (raw) {
      const detail = raw instanceof IpcFailure ? raw.detail : {};
      setFailure(errorMessage(detail.code ?? 'UNKNOWN'));
      setConfirmation(null);
    } finally {
      setKey('');
      setBusy(false);
    }
  };
  const settleClear = async (): Promise<void> => {
    setBusy(true);
    setFailure('');
    try {
      await onClear();
    } catch (raw) {
      const detail = raw instanceof IpcFailure ? raw.detail : {};
      setFailure(errorMessage(detail.code ?? 'UNKNOWN'));
      setConfirmation(null);
    } finally {
      setKey('');
      setBusy(false);
    }
  };
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!key.trim()) return;
    if (status.status === 'configured') {
      setConfirmation('overwrite');
      return;
    }
    await settleSet();
  };
  if (confirmation) {
    return (
      <Modal
        title={confirmation === 'overwrite' ? '覆盖认证' : '清除认证'}
        onClose={() => setConfirmation(null)}
      >
        <p>
          {confirmation === 'overwrite'
            ? '确定覆盖当前 DeepSeek API Key？旧凭据将无法恢复。'
            : '确定清除当前 DeepSeek API Key？之后生成任务将要求重新配置。'}
        </p>
        <div className="modal-actions">
          <button onClick={() => setConfirmation(null)}>取消</button>
          <button
            className="danger"
            onClick={() => {
              if (confirmation === 'overwrite') void settleSet();
              else void settleClear();
            }}
          >
            确认
          </button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="DeepSeek 认证" onClose={onClose}>
      <form onSubmit={(event) => void submit(event)} className="form-stack">
        <p>
          当前状态：<strong>{authStatusLabels[status.status]}</strong>
        </p>
        <label>
          API Key
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
        </label>
        {failure && <p role="alert">{failure}</p>}
        <div className="modal-actions">
          {status.status === 'configured' && (
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => setConfirmation('clear')}
            >
              清除认证
            </button>
          )}
          <button type="submit" className="primary" disabled={busy || !key.trim()}>
            保存
          </button>
        </div>
      </form>
    </Modal>
  );
};

const WelcomeView = ({
  auth,
  runtime,
  busy,
  onCreate,
  onOpen,
  onAuth,
  error,
}: {
  auth: AuthStatusDto;
  runtime: RuntimeInfoDto;
  busy: boolean;
  onCreate: () => void;
  onOpen: () => void;
  onAuth: () => void;
  error: string;
}): React.JSX.Element => (
  <main className="welcome-view">
    <header className="welcome-header">
      <div>
        <span className="brand-mark">NW</span>
        <h1>News Writer</h1>
      </div>
      <button onClick={onAuth}>
        <KeyRound size={17} />
        DeepSeek：{authStatusLabels[auth.status]}
      </button>
    </header>
    <section className="welcome-main" aria-labelledby="welcome-title">
      <div className="welcome-copy">
        <p className="eyebrow">新闻稿写作工作台</p>
        <h2 id="welcome-title">从活动纪要开始</h2>
        <p>项目将保存纪要、Prompt、新闻稿版本、批注和任务记录。认证信息始终留在本机用户目录。</p>
      </div>
      <div className="welcome-actions">
        <button className="primary command-large" onClick={onCreate} disabled={busy}>
          <FilePlus2 size={22} />
          <span>
            <strong>新建项目</strong>
            <small>选择可写目录并建立项目</small>
          </span>
        </button>
        <button className="command-large" onClick={onOpen} disabled={busy}>
          <FolderOpen size={22} />
          <span>
            <strong>打开项目</strong>
            <small>打开任意位置的 News Writer 项目</small>
          </span>
        </button>
      </div>
    </section>
    <footer className="welcome-footer">
      v{runtime.appVersion} · Electron {runtime.electronVersion} · Chromium{' '}
      {runtime.chromiumVersion}
    </footer>
    {error && (
      <div className="welcome-error" role="alert">
        {error}
      </div>
    )}
  </main>
);

const CreateDialog = ({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, profile: 'official' | 'other') => void;
}): React.JSX.Element => {
  const [name, setName] = useState('');
  const [profile, setProfile] = useState<'official' | 'other'>('official');
  return (
    <Modal title="新建项目" onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onCreate(name.trim(), profile);
        }}
      >
        <label>
          项目名称
          <input
            autoFocus
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <fieldset>
          <legend>新闻稿类型</legend>
          <label className="radio">
            <input
              type="radio"
              checked={profile === 'official'}
              onChange={() => setProfile('official')}
            />
            学院新闻稿
          </label>
          <label className="radio">
            <input
              type="radio"
              checked={profile === 'other'}
              onChange={() => setProfile('other')}
            />
            其他新闻稿
          </label>
        </fieldset>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" type="submit" disabled={!name.trim()}>
            选择目录并创建
          </button>
        </div>
      </form>
    </Modal>
  );
};

const AppMenu = ({
  onNew,
  onOpen,
  onClose,
  onSave,
  onImport,
  onArchive,
  onAuth,
  onToggleRail,
  onToggleComments,
  onToggleTabFocus,
  tabFocusMode,
}: {
  onNew: () => void;
  onOpen: () => void;
  onClose: () => void;
  onSave: () => void;
  onImport: () => void;
  onArchive: () => void;
  onAuth: () => void;
  onToggleRail: () => void;
  onToggleComments: () => void;
  onToggleTabFocus: () => void;
  tabFocusMode: boolean;
}): React.JSX.Element => {
  const [menu, setMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLElement>(null);
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement;
    if (event.key === 'Escape') {
      event.preventDefault();
      setMenu(null);
      const trigger = target
        .closest('.menu-group')
        ?.querySelector<HTMLElement>('[data-menu-trigger]');
      trigger?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const selector =
      target.getAttribute('role') === 'menuitem' ? '[role="menuitem"]' : '[data-menu-trigger]';
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>(selector) ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, items.indexOf(target));
    const delta = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1;
    items[(current + delta + items.length) % items.length]?.focus();
  };
  const group = (name: string, label: string, items: Array<[string, () => void, string?]>) => (
    <div className="menu-group">
      <button
        data-menu-trigger
        aria-haspopup="menu"
        aria-expanded={menu === name}
        title={`${label}菜单`}
        onClick={() => setMenu(menu === name ? null : name)}
      >
        {label}
      </button>
      {menu === name && (
        <div className="menu-popup" role="menu">
          {items.map(([text, action, shortcut]) => (
            <button
              role="menuitem"
              key={text}
              onClick={() => {
                setMenu(null);
                action();
              }}
            >
              <span>{text}</span>
              {shortcut && <kbd>{shortcut}</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
  return (
    <nav
      ref={menuRef}
      className="app-menu"
      aria-label="应用菜单"
      data-focus-zone="menu"
      tabIndex={-1}
      onKeyDown={onMenuKeyDown}
    >
      <div className="app-wordmark">
        <span>NW</span>News Writer
      </div>
      {group('file', '文件', [
        ['新建项目', onNew, 'Ctrl+N'],
        ['打开项目', onOpen, 'Ctrl+O'],
        ['导入活动纪要', onImport],
        ['保存当前文档', onSave, 'Ctrl+S'],
        ['关闭项目', onClose],
      ])}
      {group('edit', '编辑', [
        ['展开/折叠资源', onToggleRail],
        ['显示/隐藏批注', onToggleComments],
        [tabFocusMode ? 'Tab 键用于编辑缩进' : 'Tab 键用于移动焦点', onToggleTabFocus],
      ])}
      {group('project', '项目', [
        ['归档或恢复项目', onArchive],
        ['DeepSeek 认证', onAuth],
      ])}
    </nav>
  );
};

const VersionExplorer = ({
  state,
  dispatch,
  setLatest,
  activeTask,
}: {
  state: ReturnType<typeof createWorkspaceState>;
  dispatch: React.Dispatch<Parameters<typeof workspaceReducer>[1]>;
  setLatest: (id: string) => void;
  activeTask: boolean;
}): React.JSX.Element => {
  const nodes = projectVersions(state.view);
  return (
    <section className="version-explorer" aria-labelledby="version-heading">
      <h3 id="version-heading">版本关系</h3>
      {nodes.length === 0 ? (
        <p className="empty-note">尚未生成新闻稿。</p>
      ) : (
        <ol>
          {nodes.map((node) => (
            <li
              key={node.id}
              style={{ paddingLeft: Math.min(node.depth, 4) * 12 }}
              className={`${node.onCurrentChain ? 'current-chain' : 'branch'} ${node.isLatest ? 'latest' : ''}`}
            >
              <button
                onClick={() => dispatch({ type: 'selectVersion', versionId: node.id })}
                aria-current={state.selectedVersionId === node.id ? 'true' : undefined}
                title={`查看第 ${node.ordinal} 版${node.isLatest ? '（当前最新版）' : ''}`}
              >
                <span>
                  第 {node.ordinal} 版 {node.isLatest && <strong>当前最新版</strong>}
                </span>
                <small>
                  {node.parentOrdinal ? `基于第 ${node.parentOrdinal} 版` : '起始版本'}
                  {node.isBranch ? ' · 历史分支' : ' · 当前链'}
                </small>
              </button>
              {!node.isLatest && state.selectedVersionId === node.id && (
                <button
                  className="inline-command"
                  disabled={activeTask}
                  title={
                    activeTask ? '任务进行中不能切换最新版' : '只移动最新版指针，不删除其他版本'
                  }
                  onClick={() => setLatest(node.id)}
                >
                  设为最新版
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};

const SettingsPanel = ({
  state,
  userConfig,
  taskConfig,
  setTaskConfig,
  saveProject,
  saveUser,
  resolved,
  previewError,
  activeTask,
}: {
  state: ReturnType<typeof createWorkspaceState>;
  userConfig: UserConfigViewDto | null;
  taskConfig: ConfigDraft;
  setTaskConfig: (value: ConfigDraft) => void;
  saveProject: (value: ConfigDraft) => void;
  saveUser: (value: ConfigDraft) => void;
  resolved: ResolvedGenerationConfigDto | null;
  previewError: string;
  activeTask: boolean;
}): React.JSX.Element => {
  const [scope, setScope] = useState<'task' | 'project' | 'user'>('task');
  const initial =
    scope === 'task'
      ? taskConfig
      : scope === 'project'
        ? state.view.projectConfig
        : (userConfig?.config ?? {});
  const [draft, setDraft] = useState<ConfigDraft>(initial);
  const selectScope = (nextScope: 'task' | 'project' | 'user'): void => {
    setScope(nextScope);
    setDraft(
      nextScope === 'task'
        ? taskConfig
        : nextScope === 'project'
          ? state.view.projectConfig
          : (userConfig?.config ?? {}),
    );
  };
  const updateDraft = <Key extends keyof ConfigDraft>(key: Key, value: ConfigDraft[Key]): void => {
    const next = { ...draft };
    if (value === undefined || value === '') delete next[key];
    else next[key] = value;
    setDraft(next);
  };
  const save = (): void => {
    if (scope === 'task') setTaskConfig(draft);
    else if (scope === 'project') saveProject(draft);
    else saveUser(draft);
  };
  return (
    <section className="settings-panel">
      <div className="segmented" role="tablist" aria-label="配置层级">
        {(['task', 'project', 'user'] as const).map((item) => (
          <button
            role="tab"
            aria-selected={scope === item}
            key={item}
            onClick={() => selectScope(item)}
            disabled={activeTask}
          >
            {item === 'task' ? '单次' : item === 'project' ? '项目' : '用户'}
          </button>
        ))}
      </div>
      <div className="form-grid">
        <label>
          模型
          <select
            disabled={activeTask}
            value={draft.model ?? ''}
            onChange={(event) => updateDraft('model', event.target.value || undefined)}
          >
            <option value="">继承</option>
            <option value="deepseek-v4-pro">deepseek-v4-pro</option>
            <option value="deepseek-v4-flash">deepseek-v4-flash</option>
          </select>
        </label>
        <label>
          推理强度
          <select
            disabled={activeTask}
            value={draft.reasoningEffort ?? ''}
            onChange={(event) =>
              updateDraft(
                'reasoningEffort',
                (event.target.value || undefined) as ConfigDraft['reasoningEffort'],
              )
            }
          >
            <option value="">继承</option>
            <option value="off">关闭</option>
            <option value="low">低</option>
            <option value="medium">中（当前按高执行）</option>
            <option value="high">高</option>
          </select>
        </label>
        <label>
          目标渠道
          <input
            disabled={activeTask}
            value={draft.targetChannel ?? ''}
            placeholder="继承"
            onChange={(event) => updateDraft('targetChannel', event.target.value || undefined)}
          />
        </label>
        <label>
          目标字数
          <input
            disabled={activeTask}
            type="number"
            min={100}
            max={10000}
            value={draft.maxWords ?? ''}
            placeholder="继承"
            onChange={(event) =>
              updateDraft('maxWords', event.target.value ? Number(event.target.value) : undefined)
            }
          />
        </label>
        <label>
          超时（秒）
          <input
            disabled={activeTask}
            type="number"
            min={1}
            max={600}
            value={draft.requestTimeoutMs ? draft.requestTimeoutMs / 1000 : ''}
            placeholder="继承"
            onChange={(event) =>
              updateDraft(
                'requestTimeoutMs',
                event.target.value ? Number(event.target.value) * 1000 : undefined,
              )
            }
          />
        </label>
      </div>
      {resolved && (
        <dl className="resolved-config" aria-label="下一次任务实际配置">
          <div>
            <dt>模型</dt>
            <dd>
              {resolved.values.model}（{sourceLabels[resolved.sources.model]}）
            </dd>
          </div>
          <div>
            <dt>推理强度</dt>
            <dd>
              {resolved.values.reasoningEffort}（{sourceLabels[resolved.sources.reasoningEffort]}）
            </dd>
          </div>
          <div>
            <dt>目标渠道</dt>
            <dd>
              {resolved.values.targetChannel}（{sourceLabels[resolved.sources.targetChannel]}）
            </dd>
          </div>
          <div>
            <dt>目标字数</dt>
            <dd>
              {resolved.values.maxWords}（{sourceLabels[resolved.sources.maxWords]}）
            </dd>
          </div>
          <div>
            <dt>超时</dt>
            <dd>
              {resolved.values.requestTimeoutMs / 1000} 秒（
              {sourceLabels[resolved.sources.requestTimeoutMs]}）
            </dd>
          </div>
        </dl>
      )}
      {previewError && <p role="alert">{previewError}</p>}
      <button
        className="primary"
        onClick={save}
        disabled={state.view.status === 'archived' || activeTask}
      >
        保存{scope === 'task' ? '单次' : scope === 'project' ? '项目' : '用户'}配置
      </button>
    </section>
  );
};

const Workspace = ({
  initialView,
  auth,
  userConfig,
  onAuth,
  onNew,
  onOpen,
  onClose,
  onUserConfig,
  refreshSignal,
}: {
  initialView: ProjectViewDto;
  auth: AuthStatusDto;
  userConfig: UserConfigViewDto | null;
  onAuth: () => void;
  onNew: () => void;
  onOpen: () => void;
  onClose: (view: ProjectViewDto) => Promise<boolean>;
  onUserConfig: (value: UserConfigViewDto) => void;
  refreshSignal: number;
}): React.JSX.Element => {
  const [state, dispatch] = useReducer(workspaceReducer, initialView, createWorkspaceState);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const [taskConfig, setTaskConfig] = useState<ConfigDraft>({});
  const [resolvedConfig, setResolvedConfig] = useState<ResolvedGenerationConfigDto | null>(null);
  const [configPreviewError, setConfigPreviewError] = useState('');
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [leftFocusToken, setLeftFocusToken] = useState(0);
  const [rightFocusToken, setRightFocusToken] = useState(0);
  const [tabFocusMode, setTabFocusMode] = useState(true);
  const [revealRequest, setRevealRequest] = useState<{
    token: number;
    start: number;
    end: number;
  } | null>(null);
  const [modal, setModal] = useState<
    | 'auth'
    | 'comment'
    | 'promptWarning'
    | 'stale'
    | 'cancel'
    | 'settings'
    | 'exportFields'
    | null
  >(null);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    body: string;
    label: string;
    danger: boolean;
  } | null>(null);
  const confirmationActionRef = useRef<() => void>(() => undefined);
  const requestConfirmation = (
    title: string,
    body: string,
    label: string,
    action: () => void,
    danger = false,
  ): void => {
    confirmationActionRef.current = action;
    setConfirmation({ title, body, label, danger });
  };
  const [commentBody, setCommentBody] = useState('');
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [reanchorCommentId, setReanchorCommentId] = useState<string | null>(null);
  const [reviewEnabled, setReviewEnabled] = useState(false);
  const [retrievalEnabled, setRetrievalEnabled] = useState(true);
  const [retrievalState, setRetrievalState] = useState<
    'idle' | 'loading' | 'unavailable' | 'ready'
  >('idle');
  const [exportStatus, setExportStatus] = useState('');
  const [exportVersionId, setExportVersionId] = useState<string | null>(null);
  const [exportRequiredFields, setExportRequiredFields] = useState<
    Array<'title' | 'signOff' | 'dateText'>
  >([]);
  const [exportFields, setExportFields] = useState({ title: '', signOff: '', dateText: '' });
  const commandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const commandPendingRef = useRef(false);
  const [editorSplit, setEditorSplit] = useState(0.5);
  const [commentsWidth, setCommentsWidth] = useState(300);
  const editorWorkspaceRef = useRef<HTMLElement>(null);
  const beginPaneResize =
    (kind: 'editor' | 'comments') =>
    (event: React.PointerEvent<HTMLDivElement>): void => {
      event.preventDefault();
      const startX = event.clientX;
      const startSplit = editorSplit;
      const startCommentsWidth = commentsWidth;
      const rect = editorWorkspaceRef.current?.getBoundingClientRect();
      const onMove = (moveEvent: PointerEvent): void => {
        const dx = moveEvent.clientX - startX;
        if (kind === 'editor') {
          if (!rect || rect.width <= 0) return;
          const ratio = Math.min(
            0.8,
            Math.max(0.2, (startSplit * rect.width + dx) / rect.width),
          );
          setEditorSplit(ratio);
        } else {
          setCommentsWidth(Math.min(640, Math.max(200, startCommentsWidth - dx)));
        }
      };
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.style.cursor = '';
      };
      document.body.style.cursor = 'col-resize';
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };
  const minutesAutosaveTimerRef = useRef<number | null>(null);
  const editMinutesDraft = (value: string): void => {
    const action = { type: 'editMinutes' as const, value };
    stateRef.current = workspaceReducer(stateRef.current, action);
    dispatch(action);
    if (minutesAutosaveTimerRef.current !== null) window.clearTimeout(minutesAutosaveTimerRef.current);
    minutesAutosaveTimerRef.current = window.setTimeout(() => {
      minutesAutosaveTimerRef.current = null;
      saveMinutes();
    }, 800);
  };

  const enqueue = useCallback((name: string, operation: () => Promise<void>): void => {
    if (commandPendingRef.current) return;
    commandPendingRef.current = true;
    dispatch({ type: 'command', name });
    dispatch({ type: 'error', error: null });
    commandQueueRef.current = commandQueueRef.current
      .then(operation)
      .catch(async (raw: unknown) => {
        const failure = raw instanceof IpcFailure ? raw.detail : {};
        if (failure.code === 'PROJECT_CONFLICT' || failure.code === 'PROJECT_STATE_CONFLICT') {
          const currentSessionId = stateRef.current.view.sessionId;
          const result = await window.newsWriter.projects.resumeOwned();
          if (
            result.ok &&
            result.data.state === 'resumed' &&
            result.data.project.sessionId === currentSessionId &&
            result.data.project.revision >= stateRef.current.view.revision
          ) {
            dispatch({ type: 'replaceView', view: result.data.project, markPromptStale: true });
          }
        }
        if (failure.code?.startsWith('EXPORT_') || failure.code === 'DOCUMENT_CONTENT_INVALID') {
          const currentSessionId = stateRef.current.view.sessionId;
          const result = await window.newsWriter.projects.resumeOwned();
          if (
            result.ok &&
            result.data.state === 'resumed' &&
            result.data.project.sessionId === currentSessionId
          ) {
            dispatch({ type: 'replaceView', view: result.data.project });
          }
        }
        dispatch({
          type: 'error',
          error: {
            code: failure.code ?? 'UNKNOWN',
            safeMessage: errorMessage(failure.code ?? 'UNKNOWN'),
            diagnosticId: failure.diagnosticId ?? crypto.randomUUID(),
            ...(failure.suggestedAction ? { suggestedAction: failure.suggestedAction } : {}),
          },
        });
      })
      .finally(() => {
        commandPendingRef.current = false;
        dispatch({ type: 'command', name: null });
      });
  }, []);

  const unwrap = <T,>(result: { ok: true; data: T } | { ok: false; error: unknown }): T => {
    if (!result.ok) throw new IpcFailure(result.error);
    return result.data;
  };

  const hydrateRunningRef = useRef(false);
  const hydrateDirtyRef = useRef(false);
  const hydrate = useCallback((): void => {
    hydrateDirtyRef.current = true;
    if (hydrateRunningRef.current) return;
    hydrateRunningRef.current = true;
    void (async () => {
      try {
        while (hydrateDirtyRef.current) {
          hydrateDirtyRef.current = false;
          const result = await window.newsWriter.projects.resumeOwned();
          if (!result.ok) throw new IpcFailure(result.error);
          if (
            result.data.state === 'resumed' &&
            result.data.project.sessionId === stateRef.current.view.sessionId &&
            result.data.project.revision >= stateRef.current.view.revision
          ) {
            dispatch({ type: 'replaceView', view: result.data.project });
          }
        }
      } catch (raw) {
        const failure = raw instanceof IpcFailure ? raw.detail : {};
        dispatch({
          type: 'error',
          error: {
            code: failure.code ?? 'UNKNOWN',
            safeMessage: errorMessage(failure.code ?? 'UNKNOWN'),
            ...(failure.diagnosticId ? { diagnosticId: failure.diagnosticId } : {}),
          },
        });
      } finally {
        hydrateRunningRef.current = false;
      }
    })();
  }, []);

  useEffect(() => {
    if (refreshSignal > 0) hydrate();
  }, [hydrate, refreshSignal]);

  const latest =
    state.view.versions.find((version) => version.id === state.view.latestVersionId) ?? null;
  const selected =
    state.view.versions.find((version) => version.id === state.selectedVersionId) ?? latest;
  const activeTask = [...state.view.tasks]
    .reverse()
    .find((task) => !['succeeded', 'failed', 'cancelled', 'timedOut'].includes(task.status));
  const latestTask = [...state.view.tasks].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  )[0];
  const focusedVersion = selected ?? latest;
  const comments = focusedVersion
    ? state.view.comments.filter((comment) => comment.versionId === focusedVersion.id)
    : [];
  const isReanchoring = reanchorCommentId !== null && reanchorCommentId === editingCommentId;

  const previewSessionId = state.view.sessionId;
  const previewRevision = state.view.revision;
  useEffect(() => {
    let cancelled = false;
    void window.newsWriter.settings
      .previewConfig({
        sessionId: previewSessionId,
        expectedRevision: previewRevision,
        ...(Object.keys(taskConfig).length ? { taskConfig } : {}),
      })
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setResolvedConfig(result.data);
          setConfigPreviewError('');
        } else {
          setResolvedConfig(null);
          setConfigPreviewError(errorMessage(result.error.code));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [previewRevision, previewSessionId, taskConfig, userConfig?.revision]);

  const saveMinutes = (): void =>
    enqueue('save-minutes', async () => {
      const current = stateRef.current;
      if (!current.minutes.dirty) return;
      const view = unwrap(
        await window.newsWriter.projects.saveMinutes({
          sessionId: current.view.sessionId,
          expectedRevision: current.view.revision,
          content: current.minutes.value,
        }),
      );
      dispatch({ type: 'replaceView', view, markPromptStale: true, acceptMinutes: true });
    });

  const exportDocument = (
    requestedVersion = focusedVersion,
    overrides: Partial<{ title: string; signOff: string; dateText: string }> = {},
  ): void => {
    const version = requestedVersion;
    if (!version) return;
    enqueue('export-docx', async () => {
      const current = stateRef.current;
      setExportStatus('正在准备 DOCX');
      const result = unwrap(
        await window.newsWriter.documents.exportWithDialog({
          sessionId: current.view.sessionId,
          expectedRevision: current.view.revision,
          versionId: version.id,
          ...(overrides.title ? { title: overrides.title } : {}),
          ...(overrides.signOff ? { signOff: overrides.signOff } : {}),
          ...(overrides.dateText ? { dateText: overrides.dateText } : {}),
        }),
      );
      if (result.cancelled) {
        setExportStatus('已取消导出');
        return;
      }
      if (result.needsInput) {
        setExportVersionId(version.id);
        setExportRequiredFields(result.requiredFields);
        setExportFields({ title: '', signOff: '', dateText: '' });
        setModal('exportFields');
        return;
      }
      dispatch({ type: 'replaceView', view: result.project });
      setExportStatus(`已导出 ${result.record.fileName}`);
    });
  };
  const importMinutes = (): void =>
    enqueue('import-minutes', async () => {
      const current = stateRef.current.view;
      const result = unwrap(
        await window.newsWriter.projects.importMinutesWithDialog({
          sessionId: current.sessionId,
          expectedRevision: current.revision,
        }),
      );
      if (!result.cancelled)
        dispatch({
          type: 'replaceView',
          view: result.data,
          markPromptStale: true,
          acceptMinutes: true,
        });
    });

  const preparePrompt = (
    kind: 'draftGeneration' | 'aiReview' | 'commentRevision',
    regenerated = false,
  ): Promise<void> =>
    new Promise((resolve) => {
      enqueue('prepare-prompt', async () => {
        let current = stateRef.current;
        const existingPrompt = current.prompt;
        const expectedParent = kind === 'draftGeneration' ? null : current.view.latestVersionId;
        const existingParent = existingPrompt?.preparation.trace.parent?.versionId ?? null;
        const priorFactOverrides =
          existingPrompt?.preparation.purpose === kind && existingParent === expectedParent
            ? serializeFactOverrides(existingPrompt.factOverrides)
            : undefined;
        if (kind === 'draftGeneration' && current.minutes.dirty) {
          const view = unwrap(
            await window.newsWriter.projects.saveMinutes({
              sessionId: current.view.sessionId,
              expectedRevision: current.view.revision,
              content: current.minutes.value,
            }),
          );
          dispatch({ type: 'replaceView', view, markPromptStale: true, acceptMinutes: true });
          current = {
            ...current,
            view,
            minutes: { value: view.minutes.content, base: view.minutes.content, dirty: false },
          };
        }
        let preparedRetrievalId: string | undefined;
        if (kind === 'draftGeneration' && retrievalEnabled) {
          setRetrievalState('loading');
          const retrieval = await window.newsWriter.retrieval.search({
            sessionId: current.view.sessionId,
            expectedRevision: current.view.revision,
            query: current.minutes.value,
            topK: 5,
          });
          if (!retrieval) {
            setRetrievalState('idle');
          } else if (retrieval.ok) {
            preparedRetrievalId = retrieval.data.reportId;
            setRetrievalState('ready');
            dispatch({ type: 'replaceView', view: retrieval.data.project, markPromptStale: true });
            current = { ...current, view: retrieval.data.project };
          } else if (retrieval.error.code === 'RESOURCE_UNAVAILABLE') {
            setRetrievalState('unavailable');
          } else {
            setRetrievalState('idle');
            throw new IpcFailure(retrieval.error);
          }
        } else if (kind === 'draftGeneration') {
          setRetrievalState('idle');
        }
        const result = unwrap(
          await window.newsWriter.prompts.prepare({
            sessionId: current.view.sessionId,
            expectedRevision: current.view.revision,
            kind,
            parentVersionId: kind === 'draftGeneration' ? null : current.view.latestVersionId,
            retrievalEnabled,
            ...(kind === 'draftGeneration' && preparedRetrievalId
              ? { retrievalReportId: preparedRetrievalId as never }
              : {}),
            ...(priorFactOverrides ? { factOverrides: priorFactOverrides as never } : {}),
            ...(Object.keys(taskConfig).length ? { taskConfig } : {}),
          }),
        );
        dispatch({
          type: 'setPrompt',
          prompt: {
            value: result.messages.find((message) => message.role === 'user')?.content ?? '',
            base: result.messages.find((message) => message.role === 'user')?.content ?? '',
            systemContent:
              result.messages.find((message) => message.role === 'system')?.content ?? '',
            systemBase:
              result.messages.find((message) => message.role === 'system')?.content ?? '',
            dirty: false,
            preparation: result,
            factOverrides:
              (result as typeof result & { factOverrides?: FactOverrides }).factOverrides ?? {},
            unlocked: false,
            warningAcknowledged: false,
            stale: false,
          },
        });
        if (regenerated) window.setTimeout(() => void startTask('regenerated'), 0);
        resolve();
      });
    });

  const startTask = (
    resolution: 'current' | 'continued' | 'regenerated' = 'current',
    risksAcknowledged = false,
    duplicateAcknowledged = false,
  ): void => {
    const snapshot = stateRef.current;
    const prompt = snapshot.prompt;
    if (!prompt) return;
    if (prompt.stale && resolution === 'current') {
      setModal('stale');
      return;
    }
    const hasSentContent = snapshot.view.prompts
      .filter((item) => item.purpose === prompt.preparation.purpose)
      .some(
        (item) =>
          item.messages.find((message) => message.role === 'system')?.content ===
            prompt.systemContent &&
          item.messages.find((message) => message.role === 'user')?.content === prompt.value,
      );
    if (hasSentContent && resolution === 'current' && !duplicateAcknowledged) {
      requestConfirmation(
        'Prompt 未发生变化',
        '当前 Prompt 与上一次发送的内容完全相同。每次 AI 结果可能不同，是否仍要继续发送？',
        '仍然发送',
        () => startTask('current', risksAcknowledged, true),
      );
      return;
    }
    if (prompt.preparation.risks.length > 0 && !risksAcknowledged) {
      requestConfirmation(
        '确认生成风险',
        'Prompt 检测到缺失信息。这些提示只是线索，不是事实证明。',
        '已了解并继续',
        () => startTask(resolution, true, duplicateAcknowledged),
        true,
      );
      return;
    }
    enqueue('start-task', async () => {
      const current = stateRef.current;
      const draft = current.prompt;
      if (!draft) return;
      const oldFingerprint =
        resolution === 'regenerated' ? prompt.preparation.inputFingerprint : undefined;
      unwrap(
        await window.newsWriter.tasks.start({
          sessionId: current.view.sessionId,
          expectedRevision: current.view.revision,
          kind: draft.preparation.purpose,
          parentVersionId: draft.preparation.trace.parent?.versionId ?? null,
          ...(draft.preparation.trace.retrieval.state === 'used' ||
          draft.preparation.trace.retrieval.state === 'zeroHits'
            ? { retrievalReportId: draft.preparation.trace.retrieval.reportId }
            : {}),
          retrievalEnabled: draft.preparation.trace.retrieval.state !== 'notUsed',
          factOverrides: serializeFactOverrides(draft.factOverrides) as never,
          ...(Object.keys(taskConfig).length ? { taskConfig } : {}),
          messages: [
            { role: 'system', content: draft.systemContent },
            { role: 'user', content: draft.value },
          ],
          editedByUser: draft.dirty,
          editWarningAcknowledged: draft.dirty && draft.warningAcknowledged,
          promptInputFingerprint: draft.preparation.inputFingerprint,
          staleResolution: resolution,
          ...(oldFingerprint ? { previousPromptInputFingerprint: oldFingerprint } : {}),
          acknowledgedRiskCodes: draft.preparation.risks.map((risk) => risk.code),
          reviewEnabled,
        } as never),
      );
      hydrate();
    });
  };

  const updateFactOverride = (
    field: keyof FactOverrides,
    mode: FactOverrideMode,
    value?: string,
  ): void => {
    const prompt = stateRef.current.prompt;
    if (!prompt) return;
    const nextOverride = mode === 'manual' ? { mode, value: value ?? '' } : { mode };
    const existing = prompt.factOverrides ?? {};
    const action = {
      type: 'setPrompt',
      prompt: {
        ...prompt,
        factOverrides: { ...existing, [field]: nextOverride },
        stale: true,
      },
    } as const;
    stateRef.current = workspaceReducer(stateRef.current, action);
    dispatch(action);
  };

  const setLatest = (id: string): void => {
    requestConfirmation(
      '设为最新版',
      '这只会移动最新版指针，不会删除其后的版本或其他分支。',
      '确认设为最新版',
      () =>
        enqueue('set-latest', async () => {
          const current = stateRef.current.view;
          const view = unwrap(
            await window.newsWriter.projects.setLatestVersion({
              sessionId: current.sessionId,
              expectedRevision: current.revision,
              versionId: id as never,
            }),
          );
          const prompt = stateRef.current.prompt;
          const reusable = prompt?.preparation.trace.parent?.versionId === id;
          dispatch({ type: 'replaceView', view, markPromptStale: !reusable });
          dispatch({ type: 'selectVersion', versionId: id });
          dispatch({ type: 'setDiff', enabled: false });
        }),
    );
  };

  const addComment = (): void => {
    const current = stateRef.current;
    const version = current.view.versions.find((item) => item.id === current.view.latestVersionId);
    if (!version || !selection || !commentBody.trim()) return;
    enqueue('add-comment', async () => {
      const view = unwrap(
        await window.newsWriter.comments.add({
          sessionId: current.view.sessionId,
          expectedRevision: current.view.revision,
          versionId: version.id,
          anchor: { kind: 'textQuote', contentSha256: version.contentSha256, ...selection },
          quotedText: selection.exact,
          body: commentBody.trim(),
        }),
      );
      dispatch({ type: 'replaceView', view, markPromptStale: true });
      setCommentBody('');
      setModal(null);
      setSelection(null);
    });
  };

  const editComment = (): void => {
    const current = stateRef.current;
    const version = current.view.versions.find((item) => item.id === current.view.latestVersionId);
    const comment = current.view.comments.find((item) => item.id === editingCommentId);
    if (!version || !comment || !commentBody.trim()) return;
    const anchor =
      reanchorCommentId === comment.id && selection
        ? { kind: 'textQuote' as const, contentSha256: version.contentSha256, ...selection }
        : comment.anchor;
    enqueue('edit-comment', async () => {
      const view = unwrap(
        await window.newsWriter.comments.edit({
          sessionId: current.view.sessionId,
          expectedRevision: current.view.revision,
          commentId: comment.id,
          expectedCommentRevision: comment.revision,
          anchor,
          quotedText: anchor.exact,
          body: commentBody.trim(),
        }),
      );
      dispatch({ type: 'replaceView', view, markPromptStale: true });
      setCommentBody('');
      setEditingCommentId(null);
      setReanchorCommentId(null);
      setModal(null);
      setSelection(null);
    });
  };

  const removeComment = (commentId: string): void => {
    const current = stateRef.current;
    const comment = current.view.comments.find((item) => item.id === commentId);
    if (!comment || comment.versionId !== current.view.latestVersionId) return;
    requestConfirmation(
      '删除批注',
      '确定删除这条批注？删除后它不会再参与后续续改，且无法恢复。',
      '删除批注',
      () =>
        enqueue('delete-comment', async () => {
          const latest = stateRef.current;
          const view = unwrap(
            await window.newsWriter.comments.delete({
              sessionId: latest.view.sessionId,
              expectedRevision: latest.view.revision,
              commentId: comment.id,
              expectedCommentRevision: comment.revision,
            }),
          );
          dispatch({ type: 'replaceView', view, markPromptStale: true });
          if (editingCommentId === comment.id) {
            setEditingCommentId(null);
            setReanchorCommentId(null);
            setCommentBody('');
            setModal(null);
          }
        }),
      true,
    );
  };

  const archive = (): void => {
    const archived = state.view.status !== 'archived';
    const perform = (): void =>
      enqueue('archive', async () => {
        const current = stateRef.current.view;
        const view = unwrap(
          await window.newsWriter.projects.setArchived({
            sessionId: current.sessionId,
            expectedRevision: current.revision,
            archived,
          }),
        );
        dispatch({ type: 'replaceView', view, markPromptStale: true });
      });
    if (archived)
      requestConfirmation(
        '归档项目',
        '归档后项目变为只读，但不会删除版本或加入知识库。',
        '确认归档',
        perform,
      );
    else perform();
  };

  const saveProjectConfig = (config: ConfigDraft): void =>
    enqueue('project-config', async () => {
      const current = stateRef.current.view;
      const view = unwrap(
        await window.newsWriter.projects.updateConfig({
          sessionId: current.sessionId,
          expectedRevision: current.revision,
          config,
        }),
      );
      dispatch({ type: 'replaceView', view, markPromptStale: true });
    });
  const saveUserConfig = (config: ConfigDraft): void =>
    enqueue('user-config', async () => {
      if (!userConfig) return;
      const result = unwrap(
        await window.newsWriter.settings.updateUserConfig({
          expectedRevision: userConfig.revision,
          config,
        }),
      );
      onUserConfig(result);
      if (stateRef.current.prompt)
        dispatch({ type: 'setPrompt', prompt: { ...stateRef.current.prompt, stale: true } });
    });

  const cancelTask = (): void => {
    if (!activeTask) return;
    enqueue('cancel-task', async () => {
      const current = stateRef.current.view;
      unwrap(
        await window.newsWriter.tasks.cancel({
          sessionId: current.sessionId,
          expectedRevision: current.revision,
          taskId: activeTask.id,
        }),
      );
      setModal(null);
      hydrate();
    });
  };

  const leaveFor = (action: () => void): void => {
    if (activeTask) {
      requestConfirmation(
        '任务仍在进行',
        '请先明确取消任务并等待任务结束，再关闭或切换项目。',
        '知道了',
        () => undefined,
      );
      return;
    }
    const perform = (): void => {
      void onClose(stateRef.current.view).then((closed) => {
        if (closed) action();
      });
    };
    if (state.minutes.dirty || state.prompt?.dirty)
      requestConfirmation(
        '放弃未保存草稿',
        '存在未保存的纪要或 Prompt 草稿。关闭后本地草稿会丢失。',
        '放弃并关闭',
        perform,
        true,
      );
    else perform();
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveMinutes();
      }
      if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        leaveFor(onNew);
      }
      if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        leaveFor(onOpen);
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        if (selection && focusedVersion?.id === state.view.latestVersionId) setModal('comment');
      }
      if (event.key === 'F6') {
        event.preventDefault();
        const zones = [...document.querySelectorAll<HTMLElement>('[data-focus-zone]')].filter(
          (item) => item.offsetParent !== null,
        );
        const current = zones.findIndex((zone) => zone.contains(document.activeElement));
        const target = zones[(current + 1) % zones.length];
        if (target?.dataset.focusZone === 'left') setLeftFocusToken((token) => token + 1);
        else if (target?.dataset.focusZone === 'right') setRightFocusToken((token) => token + 1);
        else target?.focus();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  });

  const leftValue =
    state.leftDocument === 'minutes'
      ? state.minutes.value
      : state.leftDocument === 'prompt'
        ? (state.prompt?.value ?? '请先准备 Prompt。')
        : (selected?.content ?? '请选择历史版本。');
  const leftReadOnly =
    state.leftDocument === 'history' ||
    state.view.status === 'archived' ||
    (state.leftDocument === 'prompt' && !state.prompt?.unlocked);
  const leftUri = `inmemory://news-writer/session/${state.view.sessionId}/${state.leftDocument}/${state.leftDocument === 'history' ? (selected?.id ?? 'empty') : 'draft'}`;

  return (
    <main
      className={`workspace ${state.commentsOpen ? 'comments-visible' : ''}`}
      style={
        state.commentsOpen
          ? { gridTemplateColumns: `44px minmax(0, 1fr) ${commentsWidth}px` }
          : undefined
      }
    >
      <AppMenu
        onNew={() => leaveFor(onNew)}
        onOpen={() => leaveFor(onOpen)}
        onClose={() => leaveFor(() => undefined)}
        onSave={saveMinutes}
        onImport={importMinutes}
        onArchive={archive}
        onAuth={onAuth}
        onToggleRail={() => dispatch({ type: 'setRail', open: !state.railOpen })}
        onToggleComments={() => dispatch({ type: 'setComments', open: !state.commentsOpen })}
        onToggleTabFocus={() => setTabFocusMode((enabled) => !enabled)}
        tabFocusMode={tabFocusMode}
      />
      <header className="project-header">
        <div>
          <strong title={state.view.name}>{state.view.name}</strong>
          <span className="badge">
            {state.view.profile === 'official' ? '学院新闻稿' : '其他新闻稿'}
          </span>
          {state.view.status === 'archived' && <span className="badge archived">已归档</span>}
        </div>
        <div className="project-status">
          <span>
            {latest
              ? `当前最新版：第 ${projectVersions(state.view).find((item) => item.id === latest.id)?.ordinal ?? ''} 版`
              : '尚无版本'}
          </span>
          <button onClick={onAuth} title="管理 DeepSeek 认证">
            <KeyRound size={15} />
            {authStatusLabels[auth.status]}
          </button>
          {latestTask && <span aria-live="polite">{taskLabels[latestTask.status]}</span>}
        </div>
      </header>
      <aside
        className={`resource-rail ${state.railOpen ? 'open' : ''}`}
        data-focus-zone="resource"
        tabIndex={-1}
      >
        <button
          className="rail-toggle icon-button"
          onClick={() => dispatch({ type: 'setRail', open: !state.railOpen })}
          aria-label={state.railOpen ? '折叠资源' : '展开资源'}
          title={state.railOpen ? '折叠资源' : '展开资源'}
        >
          <PanelLeft size={19} />
        </button>
        {state.railOpen && (
          <>
            <VersionExplorer
              state={state}
              dispatch={dispatch}
              setLatest={setLatest}
              activeTask={Boolean(activeTask)}
            />
            <section className="export-history" aria-labelledby="export-history-heading">
              <h3 id="export-history-heading">导出记录</h3>
              {state.view.exportRecords.length === 0 ? (
                <p>尚无导出记录。</p>
              ) : (
                <ol>
                  {[...state.view.exportRecords].reverse().map((record) => {
                    const ordinal = projectVersions(state.view).find(
                      (version) => version.id === record.versionId,
                    )?.ordinal;
                    return (
                      <li key={record.id}>
                        <div>
                          <strong>第 {ordinal ?? '?'} 版</strong>
                          <span className={`export-status ${record.status}`}>
                            {record.status === 'succeeded' ? '成功' : '失败'}
                          </span>
                        </div>
                        <span title={record.fileName}>{record.fileName}</span>
                        <small>{new Date(record.completedAt).toLocaleString('zh-CN')}</small>
                        <small title={record.templateVersion}>{record.templateVersion}</small>
                        {record.status === 'failed' && (
                          <p role="alert">{record.error.safeMessage}</p>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          </>
        )}
      </aside>
      <section
        className="editor-workspace"
        ref={editorWorkspaceRef}
        style={{
          gridTemplateColumns: `${editorSplit * 100}% 6px ${(1 - editorSplit) * 100}%`,
        }}
      >
        <article className="editor-pane" data-focus-zone="left" tabIndex={-1}>
          <header>
            <div className="tabs" role="tablist">
              <button
                role="tab"
                aria-selected={state.leftDocument === 'minutes'}
                onClick={() => dispatch({ type: 'selectDocument', document: 'minutes' })}
                title="查看或编辑活动纪要"
              >
                纪要 · {countText(state.minutes.value)} 字
              </button>
              <button
                role="tab"
                aria-selected={state.leftDocument === 'prompt'}
                onClick={() => dispatch({ type: 'selectDocument', document: 'prompt' })}
                title="查看当前 Prompt；首次修改前会显示风险提示"
              >
                Prompt {state.prompt ? `· ${countText(state.prompt.value)} 字` : ''}
              </button>
              <button
                role="tab"
                aria-selected={state.leftDocument === 'history'}
                onClick={() => dispatch({ type: 'selectDocument', document: 'history' })}
                title="查看选中历史版本及其批注"
              >
                历史稿
                {selected && state.leftDocument === 'history'
                  ? ` · 第 ${projectVersions(state.view).find((item) => item.id === selected.id)?.ordinal ?? '?'} 版 · ${countText(selected.content)} 字`
                  : ''}
              </button>
            </div>
            <div className="pane-actions">
              {state.leftDocument === 'minutes' && (
                <button
                  className="icon-button"
                  onClick={saveMinutes}
                  disabled={!state.minutes.dirty || state.view.status === 'archived'}
                  aria-label="保存纪要"
                  title="保存纪要 (Ctrl+S)"
                >
                  <Save size={17} />
                </button>
              )}
              {state.leftDocument === 'prompt' && state.prompt && !state.prompt.unlocked && (
                <button title="确认风险后编辑当前 Prompt" onClick={() => setModal('promptWarning')}>
                  编辑 Prompt
                </button>
              )}
            </div>
          </header>
          <div className="editor-body">
          {state.leftDocument === 'prompt' && state.prompt && (
            <div className="prompt-system">
              <div className="prompt-system-label">
                系统与机构写作规范（{state.prompt.unlocked ? '可编辑' : '只读'}）
              </div>
              <MonacoTextEditor
                ariaLabel="系统与机构写作规范"
                uri={`${leftUri}/system`}
                value={state.prompt.systemContent}
                readOnly={leftReadOnly}
                onChange={(value) => dispatch({ type: 'editSystemPrompt', value })}
                tabFocusMode={tabFocusMode}
              />
            </div>
          )}
          <MonacoTextEditor
            ariaLabel="左侧编辑器"
            uri={leftUri}
            value={leftValue}
            readOnly={leftReadOnly}
            {...(state.leftDocument === 'minutes' ? { onSave: saveMinutes } : {})}
            focusToken={leftFocusToken}
            tabFocusMode={tabFocusMode}
            commentAnchors={
              state.leftDocument === 'history' && selected
                ? state.view.comments
                    .filter(
                      (comment) =>
                        comment.versionId === selected.id &&
                        isAnchorValid(selected.content, selected.contentSha256, comment.anchor),
                    )
                    .map((comment) => ({
                      id: comment.id,
                      start: comment.anchor.start,
                      end: comment.anchor.end,
                    }))
                : []
            }
            onChange={(value) => {
              if (state.leftDocument === 'minutes') editMinutesDraft(value);
              else if (state.leftDocument === 'prompt') dispatch({ type: 'editPrompt', value });
            }}
          />
          </div>
        </article>
        <div
          className="pane-divider"
          onPointerDown={beginPaneResize('editor')}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整左右编辑栏宽度"
        />
        <article className="editor-pane" data-focus-zone="right" tabIndex={-1}>
          <header>
            <div>
              <strong>{state.diffMode ? '版本差异' : '当前最新版'}</strong>
              {latest && (
                <small>
                  只读 · 第{' '}
                  {projectVersions(state.view).find((item) => item.id === latest.id)?.ordinal} 版
                  {' · '}
                  {countText(latest.content)} 字
                </small>
              )}
            </div>
            <div className="pane-actions">
              {selected && latest && selected.id !== latest.id && (
                <button
                  title={
                    state.diffMode ? '关闭与最新版的差异比较' : '将选中历史版本与最新版进行差异比较'
                  }
                  onClick={() => dispatch({ type: 'setDiff', enabled: !state.diffMode })}
                >
                  <GitCompare size={16} />
                  {state.diffMode ? '退出比较' : '与最新版比较'}
                </button>
              )}
              <button
                disabled={!latest || Boolean(activeTask)}
                aria-label="导出所选版本为 DOCX"
                title={focusedVersion ? '导出当前选中版本 DOCX' : '尚无可导出的版本'}
                onClick={() => exportDocument()}
              >
                <Download size={16} />
                导出 DOCX
              </button>
              <button
                className="icon-button"
                aria-label="显示批注"
                title="显示批注"
                onClick={() => dispatch({ type: 'setComments', open: true })}
              >
                <MessageSquare size={17} />
              </button>
            </div>
          </header>
          {state.diffMode && selected && latest && selected.id !== latest.id ? (
            <MonacoDiffEditor
              original={selected.content}
              modified={latest.content}
              sessionId={state.view.sessionId}
              originalId={selected.id}
              modifiedId={latest.id}
              focusToken={rightFocusToken}
              tabFocusMode={tabFocusMode}
            />
          ) : latest ? (
            <MonacoTextEditor
              ariaLabel="最新版编辑器"
              uri={`inmemory://news-writer/session/${state.view.sessionId}/version/${latest.id}`}
              value={latest.content}
              readOnly
              onSelection={setSelection}
              focusToken={rightFocusToken}
              tabFocusMode={tabFocusMode}
              commentAnchors={
                focusedVersion?.id === latest.id
                  ? state.view.comments
                      .filter(
                        (comment) =>
                          comment.versionId === latest.id &&
                          isAnchorValid(latest.content, latest.contentSha256, comment.anchor),
                      )
                      .map((comment) => ({
                        id: comment.id,
                        start: comment.anchor.start,
                        end: comment.anchor.end,
                      }))
                  : []
              }
              revealRequest={revealRequest}
            />
          ) : (
            <div className="empty-editor">
              <BookOpen size={32} />
              <strong>尚无新闻稿</strong>
              <span>保存纪要并准备 Prompt 后生成初稿。</span>
            </div>
          )}
        </article>
      </section>
      {state.commentsOpen && (
        <aside
          className="comments-pane"
          aria-labelledby="comments-heading"
          data-focus-zone="comments"
          tabIndex={-1}
        >
          <div
            className="pane-divider comments-divider"
            onPointerDown={beginPaneResize('comments')}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整批注栏宽度"
          />
          <header>
            <div>
              <h2 id="comments-heading">批注</h2>
              <small>
                {focusedVersion
                  ? `第 ${projectVersions(state.view).find((item) => item.id === focusedVersion.id)?.ordinal} 版`
                  : '无版本'}
              </small>
            </div>
            <button
              className="icon-button"
              onClick={() => dispatch({ type: 'setComments', open: false })}
              title="关闭批注"
              aria-label="关闭批注"
            >
              <X size={18} />
            </button>
          </header>
          <div
            className={
              focusedVersion && focusedVersion.id !== state.view.latestVersionId
                ? 'notice'
                : 'notice-slot'
            }
          >
            {focusedVersion && focusedVersion.id !== state.view.latestVersionId
              ? '历史版本批注只读。设为最新版后可修改。'
              : null}
          </div>
          {comments.length === 0 ? (
            <p className="empty-note">此版本没有批注。</p>
          ) : (
            <ol className="comment-list">
              {comments.map((comment) => {
                const valid = focusedVersion
                  ? isAnchorValid(
                      focusedVersion.content,
                      focusedVersion.contentSha256,
                      comment.anchor,
                    )
                  : false;
                return (
                  <li key={comment.id}>
                    <blockquote>{comment.quotedText}</blockquote>
                    <p>{comment.body}</p>
                    {!valid && (
                      <span className="error-text">批注位置无法定位，续改前请重新锚定。</span>
                    )}
                    <small>{new Date(comment.updatedAt).toLocaleString()}</small>
                    {valid && focusedVersion?.id === state.view.latestVersionId && (
                      <button
                        className="inline-command"
                        title="在右侧最新版中定位这条批注对应的文本"
                        onClick={() => {
                          setRevealRequest({
                            token: Date.now(),
                            start: comment.anchor.start,
                            end: comment.anchor.end,
                          });
                          setRightFocusToken((token) => token + 1);
                        }}
                      >
                        定位正文
                      </button>
                    )}
                    {focusedVersion?.id === state.view.latestVersionId && (
                      <button
                        className="inline-command"
                        title="编辑批注正文并保留原引用位置"
                        onClick={() => {
                          setEditingCommentId(comment.id);
                          setReanchorCommentId(null);
                          setCommentBody(comment.body);
                          setModal('comment');
                        }}
                      >
                        编辑批注
                      </button>
                    )}
                    {focusedVersion?.id === state.view.latestVersionId && (
                      <button
                        className="inline-command"
                        disabled={!selection}
                        title={
                          !selection ? '请先在当前最新版中选择新的引用文本' : '使用当前选区重新锚定'
                        }
                        onClick={() => {
                          setEditingCommentId(comment.id);
                          setReanchorCommentId(comment.id);
                          setCommentBody(comment.body);
                          setModal('comment');
                        }}
                      >
                        重新标定
                      </button>
                    )}
                    {focusedVersion?.id === state.view.latestVersionId && (
                      <button
                        className="inline-command danger"
                        title="删除这条批注，不再参与后续续改"
                        onClick={() => removeComment(comment.id)}
                      >
                        删除批注
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          <button
            className="primary full"
            disabled={
              !selection ||
              focusedVersion?.id !== state.view.latestVersionId ||
              state.view.status === 'archived'
            }
            title={!selection ? '请先在最新版中选择文本' : '为所选文本添加批注'}
            onClick={() => setModal('comment')}
          >
            为所选文本添加批注
          </button>
        </aside>
      )}
      <section className="workflow-bar">
        <div className="workflow-actions">
          <button
            title="根据活动纪要生成并查看初稿 Prompt"
            onClick={() => void preparePrompt('draftGeneration')}
            disabled={Boolean(activeTask) || state.view.status === 'archived'}
          >
            <Play size={17} />
            准备初稿 Prompt
          </button>
          <label className="workflow-toggle" title="准备初稿 Prompt 时自动检索内置历史参考稿">
            <input
              type="checkbox"
              checked={retrievalEnabled}
              onChange={(event) => {
                const enabled = event.target.checked;
                setRetrievalEnabled(enabled);
                setRetrievalState('idle');
                if (stateRef.current.prompt) {
                  dispatch({
                    type: 'setPrompt',
                    prompt: { ...stateRef.current.prompt, stale: true },
                  });
                }
              }}
              disabled={
                Boolean(activeTask) ||
                Boolean(state.pendingCommand) ||
                state.view.status === 'archived'
              }
            />
            参考稿检索
            {retrievalState === 'loading'
              ? '（检索中）'
              : retrievalState === 'unavailable'
                ? '（不可用）'
                : ''}
          </label>
          <label
            className="workflow-toggle"
            title="生成新版本前，让 AI 对初稿再次检查事实和语言规范"
          >
            <input
              type="checkbox"
              checked={reviewEnabled}
              onChange={(event) => setReviewEnabled(event.target.checked)}
              disabled={Boolean(activeTask) || state.view.status === 'archived'}
            />
            AI 二次审稿
          </label>
          <button
            title="根据当前最新版批注生成并查看更新后的 Prompt"
            onClick={() => void preparePrompt('commentRevision')}
            disabled={
              !latest ||
              state.view.comments.filter((comment) => comment.versionId === latest.id).length ===
                0 ||
              Boolean(activeTask) ||
              state.view.status === 'archived'
            }
          >
            按照批注更新 Prompt
          </button>
          {state.prompt && (
            <button
              className="primary"
              onClick={() => startTask()}
              disabled={Boolean(activeTask) || state.view.status === 'archived'}
              title="发送当前 Prompt 并生成一个不可变的新版本"
            >
              发送当前 Prompt，生成新版本
            </button>
          )}
        </div>
        <button
          className="advanced-toggle"
          disabled={Boolean(activeTask)}
          title={activeTask ? '任务进行中，配置已冻结' : '在独立窗口中编辑单次、项目或用户配置'}
          onClick={() => setModal('settings')}
        >
          <Settings size={16} />
          高级设置
        </button>
        {state.prompt && (
          <section className="fact-check" aria-label="事实检查">
            <strong>事实检查</strong>
            <span>提示用于核对，不代表事实已经得到证明。</span>
            <ul>
              {(
                [
                  ['日期', state.prompt.preparation.factCheck.date],
                  ['时间', state.prompt.preparation.factCheck.time],
                  ['地点', state.prompt.preparation.factCheck.location],
                  ['举办单位', state.prompt.preparation.factCheck.organizer],
                ] as const
              ).map(([label, item]) =>
                (() => {
                  const field = (
                    { 日期: 'date', 时间: 'time', 地点: 'location', 举办单位: 'organizer' } as const
                  )[label];
                  const override = state.prompt?.factOverrides?.[field] ?? {
                    mode: 'auto' as const,
                  };
                  const manualValue = override.mode === 'manual' ? (override.value ?? '') : '';
                  return (
                    <li key={label} className="fact-check-item">
                      <div className="fact-check-heading">
                        <span>{label}</span>
                        <strong>
                          {override.mode === 'none'
                            ? '确认没有'
                            : override.mode === 'manual'
                              ? manualValue.trim()
                                ? '手动值'
                                : '待填写'
                              : item.status === 'present'
                                ? '已识别'
                                : '缺失'}
                        </strong>
                      </div>
                      <div className="fact-check-controls">
                        <select
                          aria-label={`${label}事实来源`}
                          value={override.mode}
                          onChange={(event) =>
                            updateFactOverride(field, event.target.value as FactOverrideMode)
                          }
                        >
                          <option value="auto">自动识别</option>
                          <option value="manual">手动值</option>
                          <option value="none">确认没有</option>
                        </select>
                        {override.mode === 'manual' && (
                          <textarea
                            aria-label={`${label}手动值`}
                            value={manualValue}
                            onChange={(event) =>
                              updateFactOverride(field, 'manual', event.target.value)
                            }
                            placeholder={`填写${label}`}
                            rows={2}
                          />
                        )}
                      </div>
                      {override.mode === 'auto' && 'evidence' in item && item.evidence ? (
                        <small>{item.evidence}</small>
                      ) : override.mode === 'manual' ? (
                        <small>{manualValue.trim() ? `用户确认：${manualValue}` : '等待用户填写'}</small>
                      ) : override.mode === 'none' ? (
                        <small>用户确认未提供</small>
                      ) : null}
                    </li>
                  );
                })(),
              )}
            </ul>
            {state.prompt.preparation.factCheck.blocking && (
              <button
                onClick={() => {
                  dispatch({ type: 'selectDocument', document: 'minutes' });
                  setLeftFocusToken((token) => token + 1);
                }}
              >
                返回纪要修正
              </button>
            )}
          </section>
        )}
        {latestTask && (
          <div className="task-summary" aria-live="polite">
            <strong>{taskLabels[latestTask.status]}</strong>
            <span>{latestTask.history.map((entry) => taskLabels[entry.status]).join(' → ')}</span>
            <small>
              模型 {latestTask.configSnapshot.values.model}（
              {sourceLabels[latestTask.configSnapshot.sources.model]}） · 推理{' '}
              {latestTask.configSnapshot.values.reasoningEffort}（
              {sourceLabels[latestTask.configSnapshot.sources.reasoningEffort]}）
            </small>
            {activeTask &&
              [
                'queued',
                'preparing',
                'requesting',
                'processing',
                'reviewing',
              ].includes(activeTask.status) && (
                <button onClick={() => setModal('cancel')}>取消任务</button>
              )}
            {latestTask.error && (
              <p role="alert">
                {latestTask.error.safeMessage}
                {latestTask.error.diagnosticId
                  ? ` · 诊断编号 ${latestTask.error.diagnosticId}`
                  : ''}
              </p>
            )}
          </div>
        )}
      </section>
      <footer className="status-bar" role="status">
        <span>{state.minutes.dirty ? '纪要有未保存修改' : '项目内容已同步'}</span>
        <span title={exportStatus || undefined}>
          {state.pendingCommand
            ? state.pendingCommand === 'export-docx'
              ? '正在导出 DOCX'
              : '正在执行命令'
            : latestTask
              ? taskLabels[latestTask.status]
              : exportStatus || '就绪'}
        </span>
        <span>
          {focusedVersion
            ? `正在查看第 ${projectVersions(state.view).find((item) => item.id === focusedVersion.id)?.ordinal} 版`
            : '无版本'}
        </span>
      </footer>
      {state.error && (
        <div className="error-banner" role="alert">
          <strong>{errorMessage(state.error.code)}</strong>
          {state.error.diagnosticId && <span>诊断编号：{state.error.diagnosticId}</span>}
          {state.error.suggestedAction && <span>{state.error.suggestedAction}</span>}
          <button
            className="icon-button"
            onClick={() => dispatch({ type: 'error', error: null })}
            aria-label="关闭错误"
          >
            <X size={16} />
          </button>
        </div>
      )}
      {confirmation && (
        <Modal title={confirmation.title} onClose={() => setConfirmation(null)}>
          <p>{confirmation.body}</p>
          <div className="modal-actions">
            <button onClick={() => setConfirmation(null)}>取消</button>
            <button
              className={confirmation.danger ? 'danger' : 'primary'}
              onClick={() => {
                const action = confirmationActionRef.current;
                setConfirmation(null);
                action();
              }}
            >
              {confirmation.label}
            </button>
          </div>
        </Modal>
      )}
      {modal === 'promptWarning' && (
        <Modal title="编辑 Prompt" onClose={() => setModal(null)}>
          <p>
            修改「系统与机构写作规范」可能破坏事实约束和写作规范；修改「本轮素材」可能破坏事实准确性。修改结果由用户承担。
          </p>
          <div className="modal-actions">
            <button onClick={() => setModal(null)}>取消</button>
            <button
              className="danger"
              onClick={() => {
                dispatch({ type: 'unlockPrompt' });
                setModal(null);
              }}
            >
              我已了解，继续编辑
            </button>
          </div>
        </Modal>
      )}
      {modal === 'comment' && (
        <Modal
          title={
            isReanchoring
              ? '重新标定批注'
              : editingCommentId
                ? '编辑批注'
                : '添加批注'
          }
          onClose={() => {
            setModal(null);
            setEditingCommentId(null);
            setReanchorCommentId(null);
            setCommentBody('');
          }}
        >
          <div className="form-stack">
              {isReanchoring && (
              <p>仅替换批注引用的位置，批注正文保持不变。</p>
            )}
            <blockquote>
              {isReanchoring
                ? selection?.exact
                : editingCommentId
                  ? state.view.comments.find((item) => item.id === editingCommentId)?.quotedText
                  : selection?.exact}
            </blockquote>
            <label>
              批注正文
              <textarea
                autoFocus
                readOnly={isReanchoring}
                value={commentBody}
                onChange={(event) => setCommentBody(event.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button
                onClick={() => {
                  setModal(null);
                  setEditingCommentId(null);
                  setReanchorCommentId(null);
                  setCommentBody('');
                }}
              >
                取消
              </button>
              <button
                className="primary"
                disabled={!commentBody.trim()}
                onClick={editingCommentId ? editComment : addComment}
              >
                {isReanchoring ? '确认重新标定' : '保存批注'}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {modal === 'stale' && (
        <Modal title="Prompt 已过期" onClose={() => setModal(null)}>
          <p>纪要、配置、最新版或批注已经变化。请选择如何处理，不会自动合并。</p>
          <div className="modal-actions vertical">
            {state.prompt?.preparation.purpose !== 'draftGeneration' && (
              <button
                onClick={() => {
                  setModal(null);
                  void preparePrompt(state.prompt?.preparation.purpose ?? 'commentRevision', true);
                }}
              >
                <RotateCcw size={16} />
                重新生成 Prompt
              </button>
            )}
            <button
              className="danger"
              disabled={state.prompt?.preparation.purpose === 'draftGeneration'}
              onClick={() => {
                setModal(null);
                startTask('continued');
              }}
            >
              继续使用当前文本
            </button>
            {state.prompt?.preparation.purpose === 'draftGeneration' && (
              <p className="error-text">初稿已对应已有版本，请重新准备初稿 Prompt 后再发送。</p>
            )}
          </div>
        </Modal>
      )}
      {modal === 'cancel' && (
        <Modal title="取消任务" onClose={() => setModal(null)}>
          <p>应用将停止等待，但服务端可能继续处理并产生费用。</p>
          <div className="modal-actions">
            <button onClick={() => setModal(null)}>继续等待</button>
            <button className="danger" onClick={cancelTask}>
              停止等待
            </button>
          </div>
        </Modal>
      )}
      {modal === 'settings' && (
        <Modal title="高级设置" className="settings-modal" onClose={() => setModal(null)}>
          <SettingsPanel
            state={state}
            userConfig={userConfig}
            taskConfig={taskConfig}
            setTaskConfig={(value) => {
              setTaskConfig(value);
              if (stateRef.current.prompt)
                dispatch({
                  type: 'setPrompt',
                  prompt: { ...stateRef.current.prompt, stale: true },
                });
            }}
            saveProject={saveProjectConfig}
            saveUser={saveUserConfig}
            resolved={resolvedConfig}
            previewError={configPreviewError}
            activeTask={Boolean(activeTask)}
          />
        </Modal>
      )}
      {modal === 'exportFields' && exportVersionId && (
        <Modal title="补充导出信息" onClose={() => setModal(null)}>
          <div className="form-stack">
            <p>未能从当前稿件可靠识别以下字段。请补充后再生成 Word 文件。</p>
            {exportRequiredFields.includes('title') && (
              <label>
                标题
                <input
                  autoFocus
                  value={exportFields.title}
                  onChange={(event) =>
                    setExportFields((value) => ({ ...value, title: event.target.value }))
                  }
                />
              </label>
            )}
            {exportRequiredFields.includes('signOff') && (
              <label>
                落款
                <input
                  autoFocus={!exportRequiredFields.includes('title')}
                  value={exportFields.signOff}
                  onChange={(event) =>
                    setExportFields((value) => ({ ...value, signOff: event.target.value }))
                  }
                />
              </label>
            )}
            {exportRequiredFields.includes('dateText') && (
              <label>
                日期
                <input
                  autoFocus={
                    !exportRequiredFields.includes('title') &&
                    !exportRequiredFields.includes('signOff')
                  }
                  placeholder="例如 2026年8月12日"
                  value={exportFields.dateText}
                  onChange={(event) =>
                    setExportFields((value) => ({ ...value, dateText: event.target.value }))
                  }
                />
              </label>
            )}
            <div className="modal-actions">
              <button onClick={() => setModal(null)}>取消</button>
              <button
                className="primary"
                disabled={exportRequiredFields.some((field) => !exportFields[field].trim())}
                onClick={() => {
                  const version = stateRef.current.view.versions.find(
                    (item) => item.id === exportVersionId,
                  );
                  if (!version) return;
                  setModal(null);
                  exportDocument(version, exportFields);
                }}
              >
                继续导出
              </button>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
};

export const App = (): React.JSX.Element => {
  const [runtime, setRuntime] = useState<RuntimeInfoDto | null>(null);
  const [auth, setAuth] = useState<AuthStatusDto | null>(null);
  const [userConfig, setUserConfig] = useState<UserConfigViewDto | null>(null);
  const [view, setView] = useState<ProjectViewDto | null>(null);
  const [phase, setPhase] = useState<'booting' | 'welcome' | 'opening' | 'workspace' | 'fatal'>(
    'booting',
  );
  const [modal, setModal] = useState<'create' | 'auth' | 'recovery' | null>(null);
  const [recovery, setRecovery] = useState<ProjectLockRecoveryDescriptor | null>(null);
  const [fatal, setFatal] = useState('');
  const [refreshSignal, setRefreshSignal] = useState(0);

  const boot = useCallback(async (): Promise<void> => {
    setPhase('booting');
    const [runtimeResult, authResult, configResult, resumeResult] = await Promise.all([
      window.newsWriter.runtime.getInfo(),
      window.newsWriter.auth.getStatus(),
      window.newsWriter.settings.getUserConfig(),
      window.newsWriter.projects.resumeOwned(),
    ]);
    if (!runtimeResult.ok || !authResult.ok || !configResult.ok || !resumeResult.ok) {
      setFatal('无法初始化受信任桌面服务。');
      setPhase('fatal');
      return;
    }
    setRuntime(runtimeResult.data);
    setAuth(authResult.data);
    setUserConfig(configResult.data);
    if (resumeResult.data.state === 'resumed') {
      setView(resumeResult.data.project);
      setPhase('workspace');
    } else {
      setView(null);
      setPhase('welcome');
    }
  }, []);
  useEffect(() => {
    const unsubscribe = window.newsWriter.tasks.onStatus(() => {
      setRefreshSignal((signal) => signal + 1);
    });
    queueMicrotask(() => void boot());
    return unsubscribe;
  }, [boot]);

  const create = async (name: string, profile: 'official' | 'other'): Promise<void> => {
    setModal(null);
    setPhase('opening');
    const result = await window.newsWriter.projects.createWithDialog({
      name,
      profile,
      initialMinutes: '',
    });
    if (!result.ok) {
      setFatal(describeSafeError(result.error));
      setPhase('welcome');
      return;
    }
    if (result.data.cancelled) {
      setPhase('welcome');
      return;
    }
    setView(result.data.data);
    setPhase('workspace');
  };
  const open = async (): Promise<void> => {
    setPhase('opening');
    const result = await window.newsWriter.projects.openWithDialog();
    if (!result.ok) {
      setFatal(describeSafeError(result.error));
      setPhase('welcome');
      return;
    }
    if (result.data.cancelled) {
      setPhase('welcome');
      return;
    }
    if ('recoveryRequired' in result.data) {
      setRecovery(result.data.recoveryRequired);
      setModal('recovery');
      setPhase('welcome');
      return;
    }
    setView(result.data.data);
    setPhase('workspace');
  };
  const close = async (currentView: ProjectViewDto): Promise<boolean> => {
    const result = await window.newsWriter.projects.close({
      sessionId: currentView.sessionId,
      expectedRevision: currentView.revision,
    });
    if (!result.ok) return false;
    setView(null);
    setPhase('welcome');
    return true;
  };
  const setKey = async (apiKey: string): Promise<void> => {
    const result = await window.newsWriter.auth.setDeepSeekApiKey({ apiKey });
    if (!result.ok) throw new IpcFailure(result.error);
    setAuth(result.data);
    setModal(null);
  };
  const clearKey = async (): Promise<void> => {
    const result = await window.newsWriter.auth.clearDeepSeekApiKey({ confirmed: true });
    if (!result.ok) throw new IpcFailure(result.error);
    setAuth(result.data);
    setModal(null);
  };

  if (phase === 'booting')
    return (
      <main className="boot-view" aria-busy="true">
        <span className="brand-mark">NW</span>
        <h1>News Writer</h1>
        <p>正在连接桌面服务</p>
      </main>
    );
  if (phase === 'fatal' || !runtime || !auth)
    return (
      <main className="fatal-view">
        <h1>News Writer</h1>
        <div role="alert">{fatal || '应用无法启动。'}</div>
        <button onClick={() => void boot()}>重试</button>
      </main>
    );
  return (
    <ErrorBoundary>
      <MonacoDiagnostic />
      {phase === 'workspace' && view ? (
        <Workspace
          key={view.sessionId}
          initialView={view}
          auth={auth}
          userConfig={userConfig}
          onAuth={() => setModal('auth')}
          onNew={() => setModal('create')}
          onOpen={() => void open()}
          onClose={close}
          onUserConfig={setUserConfig}
          refreshSignal={refreshSignal}
        />
      ) : (
        <WelcomeView
          auth={auth}
          runtime={runtime}
          busy={phase === 'opening'}
          onCreate={() => setModal('create')}
          onOpen={() => void open()}
          onAuth={() => setModal('auth')}
          error={fatal}
        />
      )}
      {modal === 'create' && (
        <CreateDialog
          onClose={() => setModal(null)}
          onCreate={(name, profile) => void create(name, profile)}
        />
      )}
      {modal === 'auth' && (
        <AuthDialog
          status={auth}
          onSet={setKey}
          onClear={clearKey}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'recovery' && recovery && (
        <Modal
          title="恢复项目锁"
          onClose={() => {
            setRecovery(null);
            setModal(null);
          }}
        >
          <p>检测到一个过期锁实例。恢复只针对本次观察到的实例，不会自动重试。</p>
          <code className="instance-id">{recovery.observedInstanceId}</code>
          <div className="modal-actions">
            <button
              onClick={() => {
                setRecovery(null);
                setModal(null);
              }}
            >
              取消
            </button>
            <button
              className="danger"
              onClick={() => {
                void (async () => {
                  const token = recovery.recoveryToken;
                  setRecovery(null);
                  setModal(null);
                  setPhase('opening');
                  const result = await window.newsWriter.projects.recoverOpen({
                    recoveryToken: token,
                    confirmed: true,
                  });
                  if (result.ok) {
                    setView(result.data);
                    setPhase('workspace');
                  } else {
                    setFatal(describeSafeError(result.error));
                    setPhase('welcome');
                  }
                })();
              }}
            >
              确认恢复
            </button>
          </div>
        </Modal>
      )}
    </ErrorBoundary>
  );
};
