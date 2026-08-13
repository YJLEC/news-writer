import { IPC_CHANNELS, IPC_INVOKE_CONTRACTS } from '@news-writer/shared/ipc';
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';

import { executeIpcRequest } from './ipc-core.js';
import { isTrustedSender } from './window.js';

export type InvokeChannel = keyof typeof IPC_INVOKE_CONTRACTS;
export type FixedHandlers = Readonly<
  Record<InvokeChannel, (request: unknown, ownerId: number) => Promise<unknown>>
>;

export interface RegisterIpcOptions {
  handlers: FixedHandlers;
  getMainWindow(): BrowserWindow | null;
  developmentUrl?: string;
}

export const registerFixedIpcHandlers = (options: RegisterIpcOptions): (() => void) => {
  const channels = Object.keys(IPC_INVOKE_CONTRACTS) as InvokeChannel[];
  for (const channel of channels) {
    const contract = IPC_INVOKE_CONTRACTS[channel];
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, raw: unknown): Promise<unknown> => {
      const senderTrusted = isTrustedSender(
        event.sender,
        event.senderFrame,
        options.getMainWindow(),
        options.developmentUrl,
      );
      return await executeIpcRequest(
        contract,
        senderTrusted,
        options.handlers[channel],
        raw,
        event.sender.id,
      );
    });
  }
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
};

export const taskStatusChannel = IPC_CHANNELS.tasksStatusEvent;
