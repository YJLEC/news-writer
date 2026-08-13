import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { BrowserWindow, protocol, session, type WebContents } from 'electron';

import { isTrustedRendererUrl, rendererFileForRequest } from './protocol-path.js';

const contentTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
]);

export const trustedProductionUrl = 'app://bundle/index.html';

export const registerAppProtocol = (rendererRoot: string): void => {
  protocol.handle('app', async (request) => {
    const target = rendererFileForRequest(rendererRoot, request);
    if (target === undefined) return new Response('Not found', { status: 404 });
    try {
      return new Response(await readFile(target), {
        status: 200,
        headers: {
          'Content-Type': contentTypes[extname(target).toLowerCase()] ?? 'application/octet-stream',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
};

export const denyAllPermissions = (): void => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
};

export interface CreateWindowOptions {
  preloadPath: string;
  developmentUrl?: string;
}

export const createMainWindow = (options: CreateWindowOptions): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#f4f5f7',
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: options.developmentUrl !== undefined,
    },
  });
  const trusted = (url: string): boolean => isTrustedRendererUrl(url, options.developmentUrl);
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl !== window.webContents.getURL() || !trusted(targetUrl)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  void window.loadURL(options.developmentUrl ?? trustedProductionUrl);
  return window;
};

export const isTrustedSender = (
  sender: WebContents,
  senderFrame: { url: string; parent: unknown } | null,
  mainWindow: BrowserWindow | null,
  developmentUrl?: string,
): boolean =>
  mainWindow !== null &&
  !mainWindow.isDestroyed() &&
  sender === mainWindow.webContents &&
  !sender.isDestroyed() &&
  senderFrame !== null &&
  senderFrame.parent === null &&
  senderFrame.url === sender.getURL() &&
  isTrustedRendererUrl(senderFrame.url, developmentUrl);
