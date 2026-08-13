import {
  IPC_CHANNELS,
  IPC_EVENT_CONTRACTS,
  IPC_INVOKE_CONTRACTS,
  type NewsWriterApiV1,
  type TaskStatusEventDto,
} from '@news-writer/shared/ipc';
import { contextBridge, ipcRenderer } from 'electron';
import type { z } from 'zod';

type InvokeChannel = keyof typeof IPC_INVOKE_CONTRACTS;

const invoke = async <Channel extends InvokeChannel>(
  channel: Channel,
  request: unknown,
): Promise<z.infer<(typeof IPC_INVOKE_CONTRACTS)[Channel]['result']>> => {
  const contract = IPC_INVOKE_CONTRACTS[channel];
  const parsedRequest = contract.request.parse(request);
  const response: unknown = await ipcRenderer.invoke(channel, parsedRequest);
  return contract.result.parse(response) as z.infer<
    (typeof IPC_INVOKE_CONTRACTS)[Channel]['result']
  >;
};

const api: NewsWriterApiV1 = {
  runtime: Object.freeze({
    getInfo: async () => await invoke(IPC_CHANNELS.runtimeGetInfo, {}),
  }),
  auth: Object.freeze({
    getStatus: async () => await invoke(IPC_CHANNELS.authGetStatus, {}),
    setDeepSeekApiKey: async (input) => await invoke(IPC_CHANNELS.authSetDeepSeekApiKey, input),
    clearDeepSeekApiKey: async (input) => await invoke(IPC_CHANNELS.authClearDeepSeekApiKey, input),
  }),
  projects: Object.freeze({
    createWithDialog: async (input) => await invoke(IPC_CHANNELS.projectsCreateWithDialog, input),
    openWithDialog: async () => await invoke(IPC_CHANNELS.projectsOpenWithDialog, {}),
    resumeOwned: async () => await invoke(IPC_CHANNELS.projectsResumeOwned, {}),
    recoverOpen: async (input) => await invoke(IPC_CHANNELS.projectsRecoverOpen, input),
    close: async (input) => await invoke(IPC_CHANNELS.projectsClose, input),
    refresh: async (input) => await invoke(IPC_CHANNELS.projectsRefresh, input),
    saveMinutes: async (input) => await invoke(IPC_CHANNELS.projectsSaveMinutes, input),
    importMinutesWithDialog: async (input) =>
      await invoke(IPC_CHANNELS.projectsImportMinutesWithDialog, input),
    updateConfig: async (input) => await invoke(IPC_CHANNELS.projectsUpdateConfig, input),
    setArchived: async (input) => await invoke(IPC_CHANNELS.projectsSetArchived, input),
    setLatestVersion: async (input) => await invoke(IPC_CHANNELS.projectsSetLatestVersion, input),
  }),
  comments: Object.freeze({
    add: async (input) => await invoke(IPC_CHANNELS.commentsAdd, input),
    edit: async (input) => await invoke(IPC_CHANNELS.commentsEdit, input),
  }),
  prompts: Object.freeze({
    prepare: async (input) => await invoke(IPC_CHANNELS.promptsPrepare, input),
  }),
  settings: Object.freeze({
    getUserConfig: async () => await invoke(IPC_CHANNELS.settingsGetUserConfig, {}),
    updateUserConfig: async (input) => await invoke(IPC_CHANNELS.settingsUpdateUserConfig, input),
    previewConfig: async (input) => await invoke(IPC_CHANNELS.settingsPreviewConfig, input),
  }),
  retrieval: Object.freeze({
    search: async (input) => await invoke(IPC_CHANNELS.retrievalSearch, input),
  }),
  tasks: Object.freeze({
    start: async (input) => await invoke(IPC_CHANNELS.tasksStart, input),
    cancel: async (input) => await invoke(IPC_CHANNELS.tasksCancel, input),
    provideSupplement: async (input) => await invoke(IPC_CHANNELS.tasksProvideSupplement, input),
    onStatus: (listener: (event: TaskStatusEventDto) => void) => {
      const schema: z.ZodType<TaskStatusEventDto> =
        IPC_EVENT_CONTRACTS[IPC_CHANNELS.tasksStatusEvent];
      const handler = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
        const parsed = schema.safeParse(raw);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(IPC_CHANNELS.tasksStatusEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.tasksStatusEvent, handler);
    },
  }),
  documents: Object.freeze({
    exportWithDialog: async (input) => await invoke(IPC_CHANNELS.documentsExportWithDialog, input),
  }),
};

contextBridge.exposeInMainWorld('newsWriter', Object.freeze(api));
