import { join } from 'node:path';

import type { WorkerRunner } from '@news-writer/ai';
import { documentStyleToTokens, type DocumentStyleTokens } from '@news-writer/documents';
import type { ValidatedKnowledgeBundleV1 } from '@news-writer/retrieval';
import {
  loadInstitutionBundleFromResourcesPathV1,
  type ValidatedInstitutionBundleV1,
} from '@news-writer/institution';
import { IPC_CHANNELS, type RuntimeInfoDto } from '@news-writer/shared/ipc';
import { app, BrowserWindow, dialog, safeStorage } from 'electron';

import { CredentialService } from './credential-service.js';
import { SafeDiagnostics } from './diagnostics.js';
import { registerFixedIpcHandlers, type FixedHandlers } from './ipc.js';
import { SerialLinearizationGate } from './linearization.js';
import { ProjectService } from './project-service.js';
import { runWithWatchdog } from './shutdown.js';
import { TaskHostService } from './task-host.js';
import { UserConfigService } from './user-config-service.js';
import { createMainWindow, denyAllPermissions, registerAppProtocol } from './window.js';

const getDevelopmentRendererUrl = (): string | undefined => {
  if (!import.meta.env.DEV || app.isPackaged) return undefined;
  const candidate = process.env.ELECTRON_RENDERER_URL;
  if (!candidate) return undefined;
  const url = new URL(candidate);
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (
    url.protocol !== 'http:' ||
    !allowedHosts.has(url.hostname) ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error('ELECTRON_RENDERER_URL must use HTTP on a local development host.');
  }
  return url.href;
};

export const startDesktop = (workerRunner: WorkerRunner): void => {
  let mainWindow: BrowserWindow | null = null;
  let removeIpcHandlers: (() => void) | undefined;
  let projectService: ProjectService | undefined;
  let taskHost: TaskHostService | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let allowQuit = false;
  const diagnostics = new SafeDiagnostics();
  const credentialProjectGate = new SerialLinearizationGate();
  void app.whenReady().then(async () => {
    const developmentUrl = getDevelopmentRendererUrl();
    if (developmentUrl === undefined) registerAppProtocol(join(__dirname, '../renderer'));
    denyAllPermissions();

    const credentials = new CredentialService(app.getPath('userData'), {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value),
    });
    const resourcesPath = app.isPackaged
      ? process.resourcesPath
      : join(app.getAppPath(), 'resources');
    let institutionBundle: ValidatedInstitutionBundleV1 | undefined;
    try {
      institutionBundle = await loadInstitutionBundleFromResourcesPathV1(
        join(resourcesPath, 'institution'),
      );
    } catch {
      institutionBundle = undefined;
    }
    let documentStyleTokens: DocumentStyleTokens | undefined;
    if (institutionBundle !== undefined) {
      try {
        documentStyleTokens = documentStyleToTokens(institutionBundle.documentStyle);
      } catch {
        institutionBundle = undefined;
      }
    }
    const knowledgeBundle: ValidatedKnowledgeBundleV1 | undefined = institutionBundle?.knowledge;
    const profileSnapshot =
      institutionBundle === undefined
        ? undefined
        : ({
            profileId: institutionBundle.manifest.profileId,
            profileVersion: institutionBundle.manifest.profileVersion,
            writingRulesVersion: institutionBundle.manifest.writingRulesVersion,
            promptContractVersion: institutionBundle.manifest.promptContractVersion,
            documentStyleVersion: institutionBundle.manifest.documentStyleVersion,
            knowledgeVersion: institutionBundle.manifest.knowledgeVersion,
            resourceHash: institutionBundle.manifest.bundleContentSha256,
            rules: institutionBundle.writingRules.rules.map((rule) => rule.text),
            promptSections: institutionBundle.promptContract.sections,
          } as const);
    const runtimeInfo: RuntimeInfoDto = {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      chromiumVersion: process.versions.chrome,
      projectSchemaVersion: 1,
      knowledgeVersion: knowledgeBundle?.metadata.knowledgeVersion ?? null,
      profileId: institutionBundle?.manifest.profileId ?? null,
      profileVersion: institutionBundle?.manifest.profileVersion ?? null,
      platform: 'win32',
      arch: 'x64',
    };
    const userConfig = new UserConfigService(app.getPath('userData'));
    projectService = new ProjectService(
      {
        chooseNewProject: async (name) => {
          const result = await dialog.showSaveDialog(mainWindow!, {
            title: 'Create news project',
            defaultPath: name,
            buttonLabel: 'Create',
          });
          return result.canceled ? undefined : result.filePath;
        },
        chooseExistingProject: async () => {
          const result = await dialog.showOpenDialog(mainWindow!, {
            title: 'Open news project',
            properties: ['openDirectory'],
          });
          return result.canceled ? undefined : result.filePaths[0];
        },
        chooseMinutesFile: async () => {
          const result = await dialog.showOpenDialog(mainWindow!, {
            title: 'Import activity minutes',
            properties: ['openFile'],
            filters: [{ name: 'Text documents', extensions: ['md', 'txt'] }],
          });
          return result.canceled ? undefined : result.filePaths[0];
        },
        chooseExportPath: async (suggestedFileName) => {
          const result = await dialog.showSaveDialog(mainWindow!, {
            title: '导出新闻稿',
            defaultPath: suggestedFileName,
            buttonLabel: '导出',
            filters: [{ name: 'Word 文档', extensions: ['docx'] }],
          });
          return result.canceled ? undefined : result.filePath;
        },
      },
      {
        appVersion: runtimeInfo.appVersion,
        electronVersion: runtimeInfo.electronVersion,
        chromiumVersion: runtimeInfo.chromiumVersion,
      },
      credentials,
      credentialProjectGate,
      userConfig,
      undefined,
      knowledgeBundle,
      profileSnapshot,
      documentStyleTokens,
    );
    taskHost = new TaskHostService(
      projectService,
      credentials,
      {
        appVersion: runtimeInfo.appVersion,
        electronVersion: runtimeInfo.electronVersion,
        chromiumVersion: runtimeInfo.chromiumVersion,
      },
      workerRunner,
      () => app.quit(),
      credentialProjectGate,
    );
    const handlers: FixedHandlers = {
      [IPC_CHANNELS.runtimeGetInfo]: () => Promise.resolve(runtimeInfo),
      [IPC_CHANNELS.authGetStatus]: async () => await credentials.getStatus(),
      [IPC_CHANNELS.authSetDeepSeekApiKey]: async (raw) => {
        const apiKey = (raw as { apiKey: string }).apiKey;
        return await projectService!.setCredentialIfProjectsSafe(
          apiKey,
          async () => await credentials.setDeepSeekApiKey(apiKey),
        );
      },
      [IPC_CHANNELS.authClearDeepSeekApiKey]: async () =>
        await credentials.clearDeepSeekApiKey(true),
      [IPC_CHANNELS.projectsCreateWithDialog]: async (input, ownerId) =>
        await projectService!.createWithDialog(input as never, ownerId),
      [IPC_CHANNELS.projectsOpenWithDialog]: async (_input, ownerId) =>
        await projectService!.openWithDialog(ownerId),
      [IPC_CHANNELS.projectsResumeOwned]: async (_input, ownerId) =>
        await projectService!.resumeOwned(ownerId),
      [IPC_CHANNELS.projectsRecoverOpen]: async (input, ownerId) =>
        await projectService!.recoverOpen(input as never, ownerId),
      [IPC_CHANNELS.projectsClose]: async (input, ownerId) =>
        await projectService!.close(input as never, ownerId),
      [IPC_CHANNELS.projectsRefresh]: (input, ownerId) =>
        Promise.resolve(projectService!.refresh(input as never, ownerId)),
      [IPC_CHANNELS.projectsSaveMinutes]: async (input, ownerId) =>
        await projectService!.saveMinutes(input as never, ownerId),
      [IPC_CHANNELS.projectsImportMinutesWithDialog]: async (input, ownerId) =>
        await projectService!.importMinutesWithDialog(input as never, ownerId),
      [IPC_CHANNELS.projectsUpdateConfig]: async (input, ownerId) =>
        await projectService!.updateConfig(input as never, ownerId),
      [IPC_CHANNELS.projectsSetArchived]: async (input, ownerId) =>
        await projectService!.setArchived(input as never, ownerId),
      [IPC_CHANNELS.projectsSetLatestVersion]: async (input, ownerId) =>
        await projectService!.setLatestVersion(input as never, ownerId),
      [IPC_CHANNELS.promptsPrepare]: async (input, ownerId) =>
        await projectService!.preparePrompt(input as never, ownerId),
      [IPC_CHANNELS.settingsGetUserConfig]: async () => await projectService!.getUserConfig(),
      [IPC_CHANNELS.settingsUpdateUserConfig]: async (input) =>
        await projectService!.updateUserConfig(input as never),
      [IPC_CHANNELS.settingsPreviewConfig]: async (input, ownerId) =>
        await projectService!.previewConfig(input as never, ownerId),
      [IPC_CHANNELS.commentsAdd]: async (input, ownerId) =>
        await projectService!.addComment(input as never, ownerId),
      [IPC_CHANNELS.commentsEdit]: async (input, ownerId) =>
        await projectService!.editComment(input as never, ownerId),
      [IPC_CHANNELS.retrievalSearch]: async (input, ownerId) =>
        await projectService!.searchRetrieval(input as never, ownerId),
      [IPC_CHANNELS.tasksStart]: async (input, ownerId) => {
        taskHost!.setListener(ownerId, (event) => {
          if (
            mainWindow !== null &&
            !mainWindow.isDestroyed() &&
            mainWindow.webContents.id === ownerId &&
            !mainWindow.webContents.isDestroyed()
          ) {
            mainWindow.webContents.send(IPC_CHANNELS.tasksStatusEvent, event);
          }
        });
        return await taskHost!.start(input as never, ownerId);
      },
      [IPC_CHANNELS.tasksCancel]: async (input, ownerId) =>
        await taskHost!.cancel(input as never, ownerId),
      [IPC_CHANNELS.tasksProvideSupplement]: async (input, ownerId) =>
        await taskHost!.provideSupplement(input as never, ownerId),
      [IPC_CHANNELS.documentsExportWithDialog]: async (input, ownerId) =>
        await projectService!.exportDocumentWithDialog(input as never, ownerId),
    };

    mainWindow = createMainWindow({
      preloadPath: join(__dirname, '../preload/index.cjs'),
      ...(developmentUrl === undefined ? {} : { developmentUrl }),
    });
    removeIpcHandlers = registerFixedIpcHandlers({
      handlers,
      getMainWindow: () => mainWindow,
      ...(developmentUrl === undefined ? {} : { developmentUrl }),
    });
    const mainOwnerId = mainWindow.webContents.id;
    mainWindow.once('closed', () => {
      projectService?.discardPendingRecoveries(mainOwnerId);
      mainWindow = null;
    });
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      projectService?.discardPendingRecoveries(mainOwnerId);
      if (details.reason === 'clean-exit') return;
      diagnostics.record({ name: 'renderer-crashed' });
      app.quit();
    });
    mainWindow.on('close', (event) => {
      if (!allowQuit) {
        event.preventDefault();
        app.quit();
      }
    });
  });

  app.on('before-quit', (event) => {
    if (allowQuit) return;
    event.preventDefault();
    shutdownPromise ??= (async () => {
      removeIpcHandlers?.();
      await runWithWatchdog(
        (async () => {
          await taskHost?.shutdownAll();
          await projectService?.shutdownDocumentWorkers();
          await projectService?.closeAll();
        })(),
        10_000,
        () => {
          diagnostics.record({ name: 'shutdown-watchdog' });
          allowQuit = true;
          app.exit(0);
        },
      );
      if (!allowQuit) {
        allowQuit = true;
        app.quit();
      }
    })();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
};
