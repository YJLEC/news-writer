import type {
  ProjectViewDto,
  PromptPreparationDto,
  TaskStatusEventDto,
} from '@news-writer/shared/ipc';

export type AppPhase = 'booting' | 'welcome' | 'opening' | 'workspace' | 'fatal';
export type LeftDocument = 'minutes' | 'prompt' | 'history';

export interface DraftState {
  value: string;
  base: string;
  dirty: boolean;
}

export type FactOverrideMode = 'auto' | 'manual' | 'none';
export type FactOverride = { mode: FactOverrideMode; value?: string };
export type FactOverrides = {
  date?: FactOverride;
  time?: FactOverride;
  location?: FactOverride;
  organizer?: FactOverride;
};

export interface PromptDraft extends DraftState {
  preparation: PromptPreparationDto;
  factOverrides: FactOverrides;
  unlocked: boolean;
  warningAcknowledged: boolean;
  stale: boolean;
}

export const defaultFactOverrides = (): FactOverrides => ({
  date: { mode: 'auto' },
  time: { mode: 'auto' },
  location: { mode: 'auto' },
  organizer: { mode: 'auto' },
});

export interface UiError {
  code: string;
  safeMessage: string;
  diagnosticId?: string;
  suggestedAction?: string;
}

export interface WorkspaceState {
  view: ProjectViewDto;
  minutes: DraftState;
  prompt: PromptDraft | null;
  leftDocument: LeftDocument;
  selectedVersionId: string | null;
  diffMode: boolean;
  railOpen: boolean;
  commentsOpen: boolean;
  advancedOpen: boolean;
  pendingCommand: string | null;
  error: UiError | null;
  lastTaskEvent: TaskStatusEventDto | null;
}

export type WorkspaceAction =
  | {
      type: 'replaceView';
      view: ProjectViewDto;
      markPromptStale?: boolean;
      acceptMinutes?: boolean;
    }
  | { type: 'editMinutes'; value: string }
  | { type: 'setPrompt'; prompt: PromptDraft | null }
  | { type: 'editPrompt'; value: string }
  | { type: 'unlockPrompt' }
  | { type: 'selectDocument'; document: LeftDocument }
  | { type: 'selectVersion'; versionId: string | null }
  | { type: 'setDiff'; enabled: boolean }
  | { type: 'setRail'; open: boolean }
  | { type: 'setComments'; open: boolean }
  | { type: 'setAdvanced'; open: boolean }
  | { type: 'command'; name: string | null }
  | { type: 'error'; error: UiError | null }
  | { type: 'taskEvent'; event: TaskStatusEventDto };

export const createWorkspaceState = (view: ProjectViewDto): WorkspaceState => ({
  view,
  minutes: { value: view.minutes.content, base: view.minutes.content, dirty: false },
  prompt: null,
  leftDocument: 'minutes',
  selectedVersionId: view.latestVersionId,
  diffMode: false,
  railOpen: false,
  commentsOpen: true,
  advancedOpen: false,
  pendingCommand: null,
  error: null,
  lastTaskEvent: null,
});

export const workspaceReducer = (
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState => {
  switch (action.type) {
    case 'replaceView': {
      const serverMinutes = action.view.minutes.content;
      const latestChanged = action.view.latestVersionId !== state.view.latestVersionId;
      const minutes =
        state.minutes.dirty && !action.acceptMinutes
          ? state.minutes
          : { value: serverMinutes, base: serverMinutes, dirty: false };
      return {
        ...state,
        view: action.view,
        diffMode: latestChanged ? false : state.diffMode,
        minutes,
        prompt:
          state.prompt && (action.markPromptStale ?? latestChanged)
            ? { ...state.prompt, stale: true }
            : state.prompt,
        selectedVersionId:
          latestChanged ||
          state.selectedVersionId === null ||
          !action.view.versions.some((version) => version.id === state.selectedVersionId)
            ? action.view.latestVersionId
            : state.selectedVersionId,
      };
    }
    case 'editMinutes':
      return {
        ...state,
        minutes: {
          ...state.minutes,
          value: action.value,
          dirty: action.value !== state.minutes.base,
        },
      };
    case 'setPrompt':
      return {
        ...state,
        prompt: action.prompt,
        leftDocument: action.prompt ? 'prompt' : 'minutes',
      };
    case 'editPrompt':
      return state.prompt
        ? {
            ...state,
            prompt: {
              ...state.prompt,
              value: action.value,
              dirty: action.value !== state.prompt.base,
            },
          }
        : state;
    case 'unlockPrompt':
      return state.prompt
        ? {
            ...state,
            prompt: { ...state.prompt, unlocked: true, warningAcknowledged: true },
          }
        : state;
    case 'selectDocument':
      return { ...state, leftDocument: action.document };
    case 'selectVersion':
      return { ...state, selectedVersionId: action.versionId, leftDocument: 'history' };
    case 'setDiff':
      return { ...state, diffMode: action.enabled };
    case 'setRail':
      return { ...state, railOpen: action.open };
    case 'setComments':
      return { ...state, commentsOpen: action.open };
    case 'setAdvanced':
      return { ...state, advancedOpen: action.open };
    case 'command':
      return { ...state, pendingCommand: action.name };
    case 'error':
      return { ...state, error: action.error };
    case 'taskEvent':
      if (action.event.sessionId !== state.view.sessionId) return state;
      if (
        state.lastTaskEvent?.taskId === action.event.taskId &&
        state.lastTaskEvent.occurredAt >= action.event.occurredAt
      ) {
        return state;
      }
      return { ...state, lastTaskEvent: action.event };
  }
};

export interface VersionNode {
  id: ProjectViewDto['versions'][number]['id'];
  ordinal: number;
  parentOrdinal: number | null;
  depth: number;
  onCurrentChain: boolean;
  isLatest: boolean;
  isBranch: boolean;
  createdAt: string;
}

export const projectVersions = (view: ProjectViewDto): VersionNode[] => {
  const byId = new Map(view.versions.map((version) => [version.id, version]));
  const ordered = [...view.versions].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const ordinal = new Map(ordered.map((version, index) => [version.id, index + 1]));
  const chain = new Set<string>();
  let cursor = view.latestVersionId ? byId.get(view.latestVersionId) : undefined;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    chain.add(cursor.id);
    cursor = cursor.parentVersionId ? byId.get(cursor.parentVersionId) : undefined;
  }
  const depthOf = (id: ProjectViewDto['versions'][number]['id']): number => {
    let depth = 0;
    let item = byId.get(id);
    const seen = new Set<string>();
    while (item?.parentVersionId && !seen.has(item.id)) {
      seen.add(item.id);
      depth += 1;
      item = byId.get(item.parentVersionId);
    }
    return depth;
  };
  return ordered.map((version) => ({
    id: version.id,
    ordinal: ordinal.get(version.id) ?? 0,
    parentOrdinal: version.parentVersionId ? (ordinal.get(version.parentVersionId) ?? null) : null,
    depth: depthOf(version.id),
    onCurrentChain: chain.has(version.id),
    isLatest: version.id === view.latestVersionId,
    isBranch: !chain.has(version.id),
    createdAt: version.createdAt,
  }));
};

export interface TextSelection {
  start: number;
  end: number;
  exact: string;
  prefix: string;
  suffix: string;
}

export const makeTextSelection = (
  content: string,
  start: number,
  end: number,
): TextSelection | null => {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return null;
  const exact = content.slice(start, end);
  if (!exact) return null;
  return {
    start,
    end,
    exact,
    prefix: content.slice(Math.max(0, start - 256), start),
    suffix: content.slice(end, end + 256),
  };
};

export const isAnchorValid = (
  content: string,
  contentSha256: string,
  anchor: {
    contentSha256: string;
    start: number;
    end: number;
    exact: string;
    prefix: string;
    suffix: string;
  },
): boolean => {
  if (anchor.contentSha256 !== contentSha256) return false;
  return (
    content.slice(anchor.start, anchor.end) === anchor.exact &&
    content.slice(Math.max(0, anchor.start - anchor.prefix.length), anchor.start) ===
      anchor.prefix &&
    content.slice(anchor.end, anchor.end + anchor.suffix.length) === anchor.suffix
  );
};
