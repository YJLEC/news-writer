import { createHash, randomUUID } from 'node:crypto';

import {
  addComment,
  addImages,
  archiveProject,
  clearImages,
  createProject,
  deleteComment,
  editComment,
  checkMissingFacts,
  recordExport,
  recordRetrieval,
  removeImage,
  reorderImages,
  fingerprintCommentSnapshot,
  orderCommentSnapshots,
  preparePrompt as buildPrompt,
  resolveBranchFacts,
  resolveFactOverrides,
  resolveGenerationConfig,
  DEFAULT_GENERATION_CONFIG,
  restoreProject,
  saveMinutes,
  setLatestVersion,
  textQuoteAnchorSchema,
  transitionTask,
  updateProjectConfig,
  type GenerationConfigOverrides,
  type GenerationConfigValues,
  type ProjectAggregateV1,
  type PromptPreparation,
} from '@news-writer/domain';
import {
  DOCUMENT_TEMPLATE_VERSION,
  DocumentError,
  NodeDocumentWorkerRunner,
  type DocumentStyleTokens,
  missingNewsDocumentFields,
  parseNewsDocument,
  suggestDocxFileName,
  type NewsDocument,
  type DocumentWorkerRunner,
} from '@news-writer/documents';
import {
  buildRetrievalReportV1,
  findForbiddenKnowledgeTextPatternsV1,
  normalizeRetrievalTextV1,
  redactKnowledgeCandidateV1,
  type ValidatedKnowledgeBundleV1,
} from '@news-writer/retrieval';
import type { WritingProfileSnapshot } from '@news-writer/domain';
import {
  canonicalizeProjectRoot,
  createProjectOnDisk,
  makeCommitId,
  makeTransactionId,
  openProject,
  ProjectError,
  recoverProjectLock,
  type ProjectSession,
} from '@news-writer/project';
import {
  commentIdSchema,
  exportRecordIdSchema,
  imageArtifactRefSchema,
  imageIdSchema,
  retrievalReportIdSchema,
  containsSecretMaterial,
  projectRelativePathSchema,
  sha256Schema,
  safeAppErrorSchema,
  systemClock,
  textArtifactRefSchema,
  timestampSchema,
  type IdGenerator,
  type ImageArtifactRef,
  type RuntimeVersionSnapshot,
  type TextArtifactRef,
} from '@news-writer/shared';
import {
  projectLockRecoveryDescriptorSchema,
  sessionIdSchema,
  type AddCommentDto,
  type AddImagesDto,
  type ClearImagesDto,
  type CreateProjectDto,
  type DeleteCommentDto,
  type EditCommentDto,
  type ExportDocumentDto,
  type ExportDocumentResultDto,
  type ExportRecordViewDto,
  type ImagesListDto,
  type ImagesListResultDto,
  type ProjectViewDto,
  type RemoveImageDto,
  type ReorderImagesDto,
  type SaveMinutesDto,
  type SessionId,
  type SessionRequest,
  type SetArchivedDto,
  type SetLatestVersionDto,
  type UpdateProjectConfigDto,
  type PreparePromptDto,
  type PreviewConfigDto,
  type RetrievalQueryDto,
  type RetrievalViewDto,
  type RecoverProjectOpenDto,
  type UpdateUserConfigDto,
  type UserConfigViewDto,
} from '@news-writer/shared/ipc';

import { SafeMainError } from './ipc-core.js';
import { readBoundedFile } from './bounded-file-read.js';
import { SerialLinearizationGate, type LinearizationGate } from './linearization.js';
import { ExportFileError, publishDocxAtomic } from './document-publish.js';

const maxImportedMinutesBytes = 1_000_000;

export interface ProjectDialogPort {
  chooseNewProject(name: string): Promise<string | undefined>;
  chooseExistingProject(): Promise<string | undefined>;
  chooseMinutesFile(): Promise<string | undefined>;
  chooseExportPath?(suggestedFileName: string): Promise<string | undefined>;
}

export interface ProjectCredentialPort {
  readConfiguredApiKey(): Promise<string | undefined>;
}

export interface ProjectUserConfigPort {
  get(): Promise<UserConfigViewDto>;
  update(expectedRevision: number, config: GenerationConfigOverrides): Promise<UserConfigViewDto>;
}

interface OwnedSession {
  sessionId: SessionId;
  ownerId: number;
  canonicalRoot: string;
  project: ProjectSession;
  closing: boolean;
}

interface PendingLockRecovery {
  token: string;
  ownerId: number;
  canonicalRoot: string;
  observedInstanceId: string;
  expiresAtMs: number;
  expiryTimer: ReturnType<typeof setTimeout>;
}

const lockRecoveryTtlMs = 2 * 60 * 1_000;

const ids: IdGenerator = { next: () => randomUUID() };

const artifact = (
  relativePath: string,
  content: string,
  mediaType: 'text/markdown' | 'text/plain',
): TextArtifactRef => {
  const bytes = Buffer.from(content, 'utf8');
  return textArtifactRefSchema.parse({
    relativePath: projectRelativePathSchema.parse(relativePath),
    sha256: sha256Schema.parse(createHash('sha256').update(bytes).digest('hex')),
    byteLength: bytes.byteLength,
    mediaType,
    encoding: 'utf-8',
  });
};

const imageArtifact = (
  relativePath: string,
  bytes: Uint8Array,
  widthPx: number,
  heightPx: number,
): ImageArtifactRef =>
  imageArtifactRefSchema.parse({
    relativePath: projectRelativePathSchema.parse(relativePath),
    sha256: sha256Schema.parse(createHash('sha256').update(bytes).digest('hex')),
    byteLength: bytes.byteLength,
    mediaType: 'image/jpeg',
    widthPx,
    heightPx,
  });

const isActiveTask = (project: ProjectAggregateV1): boolean =>
  project.tasks.some(
    (task) => !['succeeded', 'failed', 'cancelled', 'timedOut'].includes(task.status),
  );

const sha256Utf8 = (text: string) =>
  sha256Schema.parse(createHash('sha256').update(text, 'utf8').digest('hex'));

const exportRecordView = (
  record: ProjectAggregateV1['exportRecords'][number],
): ExportRecordViewDto =>
  record.status === 'succeeded'
    ? {
        id: record.id,
        versionId: record.versionId,
        attemptedAt: record.attemptedAt,
        completedAt: record.completedAt,
        fileName: record.fileName,
        status: record.status,
        templateVersion: record.templateVersion,
        outputSha256: record.outputSha256,
        byteLength: record.byteLength,
      }
    : {
        id: record.id,
        versionId: record.versionId,
        attemptedAt: record.attemptedAt,
        completedAt: record.completedAt,
        fileName: record.fileName,
        status: record.status,
        templateVersion: record.templateVersion,
        error: record.error,
      };

export class ProjectService {
  readonly #dialogs: ProjectDialogPort;
  readonly #runtime: RuntimeVersionSnapshot;
  readonly #credentials: ProjectCredentialPort;
  readonly #gate: LinearizationGate;
  readonly #userConfig: ProjectUserConfigPort;
  readonly #documentWorker: DocumentWorkerRunner;
  readonly #knowledgeBundle: ValidatedKnowledgeBundleV1 | undefined;
  readonly #profileSnapshot: WritingProfileSnapshot | undefined;
  readonly #documentStyleTokens: DocumentStyleTokens | undefined;
  readonly #sessions = new Map<SessionId, OwnedSession>();
  readonly #roots = new Map<string, OwnedSession>();
  readonly #pendingRecoveries = new Map<string, PendingLockRecovery>();
  readonly #openAttempts = new Map<number, number>();

  constructor(
    dialogs: ProjectDialogPort,
    runtime: RuntimeVersionSnapshot,
    credentials: ProjectCredentialPort = {
      readConfiguredApiKey: () => Promise.resolve(undefined),
    },
    gate: LinearizationGate = new SerialLinearizationGate(),
    userConfig: ProjectUserConfigPort = {
      get: () => Promise.resolve({ revision: 0, config: {} }),
      update: (_expectedRevision, config) => Promise.resolve({ revision: 1, config }),
    },
    documentWorker: DocumentWorkerRunner = new NodeDocumentWorkerRunner(),
    knowledgeBundle?: ValidatedKnowledgeBundleV1,
    profileSnapshot?: WritingProfileSnapshot,
    documentStyleTokens?: DocumentStyleTokens,
  ) {
    this.#dialogs = dialogs;
    this.#runtime = runtime;
    this.#credentials = credentials;
    this.#gate = gate;
    this.#userConfig = userConfig;
    this.#documentWorker = documentWorker;
    this.#knowledgeBundle = knowledgeBundle;
    this.#profileSnapshot = profileSnapshot;
    this.#documentStyleTokens = documentStyleTokens;
  }

  async searchRetrieval(input: RetrievalQueryDto, ownerId: number): Promise<RetrievalViewDto> {
    return await this.#gate.run(async () => {
      const owned = this.#owned(input.sessionId, ownerId);
      const current = owned.project.read();
      this.#assertProfileWriteCompatible(current);
      this.#assertRevision(owned, input.expectedRevision);
      if (current.status !== 'active') {
        throw new SafeMainError(this.#stateConflict('Archived projects cannot search references'));
      }
      if (this.#knowledgeBundle === undefined) {
        throw new SafeMainError(this.#resourceUnavailable());
      }

      const configuredKey = await this.#credentials.readConfiguredApiKey();
      const redactedQuery = normalizeRetrievalTextV1(
        redactKnowledgeCandidateV1(input.query).redactedText,
      );
      const forbiddenQueryPatterns = findForbiddenKnowledgeTextPatternsV1(redactedQuery);
      if (
        forbiddenQueryPatterns.includes('absolutePath') ||
        forbiddenQueryPatterns.includes('invalidCharacter')
      ) {
        throw new SafeMainError(this.#contentInvalid());
      }
      this.#assertStringsSafe([JSON.stringify({ ...input, query: redactedQuery })], configuredKey);
      const minutes = owned.project.readText(current.minutes.contentRef);
      const factCheck = checkMissingFacts({ minutes });
      const createdAt = systemClock.now();
      const report = buildRetrievalReportV1(this.#knowledgeBundle, {
        id: retrievalReportIdSchema.parse(ids.next('retrievalReport')),
        createdAt,
        redactedText: redactedQuery,
        factHints: {
          dates: [],
          times: [],
          locations: [],
          participants: [],
          missing: (['date', 'location', 'organizer'] as const).filter(
            (field) => factCheck[field].status === 'missing',
          ),
        },
        topK: input.topK,
      });
      const next = recordRetrieval(
        current,
        report,
        input.expectedRevision,
        createdAt,
        this.#runtime,
      );
      this.#assertAggregateSafe(next, undefined, configuredKey);
      await owned.project.commit({
        transactionId: makeTransactionId(),
        commitId: makeCommitId(),
        expectedRevision: input.expectedRevision,
        expectedHeadCommitId: owned.project.headCommitId,
        nextAggregate: next,
      });
      return {
        reportId: report.id,
        knowledgeVersion: report.knowledgeVersion,
        retrievalEngineVersion: report.retrievalEngineVersion,
        hits: report.hits,
        missingFacts: report.factHints.missing,
        project: this.#view(owned),
      };
    });
  }

  async exportDocumentWithDialog(
    input: ExportDocumentDto,
    ownerId: number,
  ): Promise<ExportDocumentResultDto> {
    const owned = this.#owned(input.sessionId, ownerId);
    this.#assertRevision(owned, input.expectedRevision);
    const initial = owned.project.read();
    const version = initial.versions.find((candidate) => candidate.id === input.versionId);
    if (version === undefined)
      throw new SafeMainError(this.#documentSafeError('DOCUMENT_CONTENT_INVALID', false));
    const source = owned.project.readText(version.contentRef);
    let document: NewsDocument;
    let suggested: string;
    try {
      document = parseNewsDocument(source, {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.signOff === undefined ? {} : { signOff: input.signOff }),
        ...(input.dateText === undefined ? {} : { dateText: input.dateText }),
      });
      suggested = suggestDocxFileName(document);
    } catch {
      const requiredFields: Array<'title' | 'signOff' | 'dateText'> = missingNewsDocumentFields(
        source,
      ).filter((field) => input[field] === undefined);
      if (
        requiredFields.length > 0 &&
        input.title === undefined &&
        input.signOff === undefined &&
        input.dateText === undefined
      ) {
        return { cancelled: false, needsInput: true, requiredFields };
      }
      throw new SafeMainError(this.#documentSafeError('DOCUMENT_CONTENT_INVALID', false));
    }
    const target = await this.#dialogs.chooseExportPath?.(suggested);
    if (target === undefined) return { cancelled: true };
    return await this.#gate.run(async () => {
      const currentOwned = this.#owned(input.sessionId, ownerId);
      this.#assertRevision(currentOwned, input.expectedRevision);
      const current = currentOwned.project.read();
      const currentVersion = current.versions.find((candidate) => candidate.id === input.versionId);
      if (
        currentVersion === undefined ||
        currentVersion.contentRef.sha256 !== version.contentRef.sha256
      )
        throw new SafeMainError(this.#conflict());
      document.images = current.images.map((image) => ({
        dataBase64: currentOwned.project.readImage(image.ref).toString('base64'),
        widthPx: image.ref.widthPx,
        heightPx: image.ref.heightPx,
      }));
      const attemptedAt = systemClock.now();
      const id = exportRecordIdSchema.parse(ids.next('exportRecord'));
      const fileName = (await import('node:path')).basename(target);
      const exportTransactionId = makeTransactionId();
      let outputPublished = false;
      let succeededRecordPersisted = false;
      let succeededRecord: ProjectAggregateV1['exportRecords'][number] | undefined;
      try {
        const bytes = await this.#documentWorker.generate(document, this.#documentStyleTokens);
        const output = await publishDocxAtomic(target, bytes);
        outputPublished = true;
        const completedAt = systemClock.now();
        const record = {
          id,
          versionId: input.versionId,
          attemptedAt,
          completedAt,
          fileName,
          templateVersion: DOCUMENT_TEMPLATE_VERSION,
          appVersion: this.#runtime.appVersion,
          status: 'succeeded' as const,
          outputSha256: sha256Schema.parse(output.sha256),
          byteLength: output.byteLength,
        };
        succeededRecord = record;
        const next = recordExport(
          current,
          succeededRecord,
          current.revision,
          completedAt,
          this.#runtime,
        );
        try {
          await currentOwned.project.commit({
            transactionId: exportTransactionId,
            commitId: makeCommitId(),
            expectedRevision: current.revision,
            expectedHeadCommitId: currentOwned.project.headCommitId,
            nextAggregate: next,
          });
        } catch {
          const refreshed = await currentOwned.project.refresh();
          const authoritativeRecord = refreshed.exportRecords.find(
            (candidate) => candidate.id === id,
          );
          if (
            authoritativeRecord === undefined ||
            JSON.stringify(authoritativeRecord) !== JSON.stringify(record)
          )
            throw new SafeMainError(
              this.#documentSafeError(
                'EXPORT_IO_ERROR',
                true,
                'The file was written but its project record could not be saved',
              ),
            );
          succeededRecordPersisted = true;
        }
        succeededRecordPersisted = true;
        return {
          cancelled: false,
          needsInput: false,
          project: this.#view(currentOwned),
          record: exportRecordView(record),
        };
      } catch (error) {
        if (outputPublished && succeededRecord) {
          try {
            const refreshed = await currentOwned.project.refresh();
            const authoritativeRecord = refreshed.exportRecords.find(
              (candidate) => candidate.id === succeededRecord!.id,
            );
            if (
              authoritativeRecord !== undefined &&
              JSON.stringify(authoritativeRecord) === JSON.stringify(succeededRecord)
            ) {
              return {
                cancelled: false,
                needsInput: false,
                project: this.#view(currentOwned),
                record: exportRecordView(succeededRecord),
              };
            }
          } catch {
            // The renderer will refresh its session before the next command.
          }
        }
        if (error instanceof SafeMainError) throw error;
        const code =
          error instanceof ExportFileError
            ? error.code
            : error instanceof DocumentError
              ? error.code
              : 'EXPORT_IO_ERROR';
        const safeError = this.#documentSafeError(
          code,
          code === 'EXPORT_ATOMIC_REPLACE_FAILED' || code === 'EXPORT_IO_ERROR',
          undefined,
          randomUUID(),
        );
        const failedAt = systemClock.now();
        const failed = {
          id,
          versionId: input.versionId,
          attemptedAt,
          completedAt: failedAt,
          fileName,
          templateVersion: DOCUMENT_TEMPLATE_VERSION,
          appVersion: this.#runtime.appVersion,
          status: 'failed' as const,
          error: safeError,
        };
        if (!outputPublished && !succeededRecordPersisted)
          try {
            const authoritative = currentOwned.project.read();
            const next = recordExport(
              authoritative,
              failed,
              authoritative.revision,
              failedAt,
              this.#runtime,
            );
            await currentOwned.project.commit({
              transactionId: makeTransactionId(),
              commitId: makeCommitId(),
              expectedRevision: authoritative.revision,
              expectedHeadCommitId: currentOwned.project.headCommitId,
              nextAggregate: next,
            });
          } catch {
            /* The original safe export error remains authoritative. */
          }
        throw new SafeMainError(safeError);
      }
    });
  }

  async shutdownDocumentWorkers(): Promise<void> {
    await this.#documentWorker.shutdown();
  }

  async createWithDialog(input: CreateProjectDto, ownerId: number) {
    this.#assertStringsSafe(
      [JSON.stringify(input)],
      await this.#credentials.readConfiguredApiKey(),
    );
    const root = await this.#dialogs.chooseNewProject(input.name);
    if (root === undefined) return { cancelled: true as const };
    return await this.#gate.run(async () => {
      const configuredKey = await this.#credentials.readConfiguredApiKey();
      this.#assertStringsSafe([JSON.stringify(input)], configuredKey);
      const projectId = randomUUID();
      const minuteId = randomUUID();
      const minuteRevisionId = randomUUID();
      const generated = [projectId, minuteId, minuteRevisionId];
      const createIds: IdGenerator = {
        next: () => {
          const value = generated.shift();
          if (value === undefined) throw new Error('project ID sequence exhausted');
          return value;
        },
      };
      const contentRef = artifact(
        `content/minutes/${minuteId}/${minuteRevisionId}.md`,
        input.initialMinutes,
        'text/markdown',
      );
      const aggregate = createProject(
        {
          name: input.name,
          profile: input.profile,
          minutesContentRef: contentRef,
          ...(input.projectConfig === undefined ? {} : { projectConfig: input.projectConfig }),
          runtime: this.#runtime,
          ...(this.#profileSnapshot === undefined
            ? {}
            : { profileSnapshot: this.#profileSnapshot }),
        },
        { clock: systemClock, ids: createIds },
      );
      this.#assertAggregateSafe(
        aggregate,
        new Map([[contentRef.relativePath, input.initialMinutes]]),
        configuredKey,
      );
      const project = await createProjectOnDisk({
        root,
        appVersion: this.#runtime.appVersion,
        aggregate,
        artifacts: new Map([[contentRef.relativePath, input.initialMinutes]]),
      });
      const owned = this.#register(project, ownerId);
      return { cancelled: false as const, data: this.#view(owned) };
    });
  }

  async openWithDialog(ownerId: number) {
    const attempt = this.#beginOpenAttempt(ownerId);
    const root = await this.#dialogs.chooseExistingProject();
    if (root === undefined) return { cancelled: true as const };
    const canonicalRoot = await canonicalizeProjectRoot(root);
    return await this.#gate.run(async () => {
      if (this.#openAttempts.get(ownerId) !== attempt) {
        throw new SafeMainError(
          this.#stateConflict('A newer project open request replaced this request'),
        );
      }
      const existing = this.#roots.get(canonicalRoot.toLocaleLowerCase('en-US'));
      if (existing !== undefined) {
        if (existing.ownerId !== ownerId || existing.closing)
          throw new SafeMainError(this.#senderRejected());
        await this.#assertSessionSafe(existing.project);
        return { cancelled: false as const, data: this.#view(existing) };
      }
      let project: ProjectSession | undefined;
      try {
        project = await openProject({
          root: canonicalRoot,
          appVersion: this.#runtime.appVersion,
        });
      } catch (error) {
        if (
          error instanceof ProjectError &&
          error.code === 'PROJECT_LOCK_RECOVERY_REQUIRED' &&
          error.observedLockInstanceId !== undefined
        ) {
          return {
            cancelled: false as const,
            recoveryRequired: this.#rememberRecovery(
              ownerId,
              canonicalRoot,
              error.observedLockInstanceId,
            ),
          };
        }
        throw error;
      }
      try {
        if (project === undefined) throw new Error('Project open did not return a session');
        return { cancelled: false as const, data: await this.#finishOpen(project, ownerId) };
      } catch (error) {
        await project?.close().catch(() => undefined);
        throw error;
      }
    });
  }

  async recoverOpen(input: RecoverProjectOpenDto, ownerId: number): Promise<ProjectViewDto> {
    return await this.#gate.run(async () => {
      const pending = this.#pendingRecoveries.get(input.recoveryToken);
      if (pending === undefined || pending.ownerId !== ownerId) {
        throw new SafeMainError(this.#senderRejected());
      }
      this.#clearPendingRecovery(pending.token);
      if (Date.now() >= pending.expiresAtMs) {
        throw new ProjectError(
          'PROJECT_LOCK_RECOVERY_REQUIRED',
          'The project lock recovery confirmation expired; reopen the project',
        );
      }
      if (this.#roots.has(pending.canonicalRoot.toLocaleLowerCase('en-US'))) {
        throw new SafeMainError(
          this.#stateConflict('The project was opened before lock recovery completed'),
        );
      }
      await recoverProjectLock(pending.canonicalRoot, pending.observedInstanceId, true);
      const project = await openProject({
        root: pending.canonicalRoot,
        appVersion: this.#runtime.appVersion,
      });
      try {
        return await this.#finishOpen(project, ownerId);
      } catch (error) {
        await project.close().catch(() => undefined);
        throw error;
      }
    });
  }

  async resumeOwned(ownerId: number) {
    return await this.#gate.run(async () => {
      const matches = [...this.#sessions.values()].filter(
        (candidate) => candidate.ownerId === ownerId && !candidate.closing,
      );
      if (matches.length === 0) return { state: 'none' as const };
      if (matches.length !== 1) {
        throw new SafeMainError(
          this.#stateConflict('The current window has an invalid project session state'),
        );
      }
      const owned = matches[0]!;
      await owned.project.refresh();
      await this.#assertSessionSafe(owned.project);
      return { state: 'resumed' as const, project: this.#view(owned) };
    });
  }

  discardPendingRecoveries(ownerId: number): void {
    this.#invalidatePendingRecoveries(ownerId);
    this.#openAttempts.delete(ownerId);
  }

  async close(input: SessionRequest, ownerId: number): Promise<{ closed: true }> {
    return await this.#gate.run(async () => {
      const owned = this.#owned(input.sessionId, ownerId);
      this.#assertRevision(owned, input.expectedRevision);
      if (isActiveTask(owned.project.read())) {
        throw new SafeMainError(
          this.#stateConflict('An active task must finish before closing the project'),
        );
      }
      owned.closing = true;
      await owned.project.close();
      this.#sessions.delete(owned.sessionId);
      this.#roots.delete(owned.canonicalRoot.toLocaleLowerCase('en-US'));
      return { closed: true };
    });
  }

  refresh(input: SessionRequest, ownerId: number): ProjectViewDto {
    const owned = this.#owned(input.sessionId, ownerId);
    this.#assertRevision(owned, input.expectedRevision);
    return this.#view(owned);
  }

  async saveMinutes(input: SaveMinutesDto, ownerId: number): Promise<ProjectViewDto> {
    return await this.#mutate(input, ownerId, (_owned, current) => {
      const revisionId = randomUUID();
      const ref = artifact(
        `content/minutes/${current.minutes.minuteId}/${revisionId}.md`,
        input.content,
        'text/markdown',
      );
      const next = saveMinutes(current, ref, input.expectedRevision, {
        ids: { next: () => revisionId },
        clock: systemClock,
        runtime: this.#runtime,
      });
      return { next, artifacts: new Map([[ref.relativePath, input.content]]) };
    });
  }

  async importMinutesWithDialog(input: SessionRequest, ownerId: number) {
    this.#owned(input.sessionId, ownerId);
    const selected = await this.#dialogs.chooseMinutesFile();
    if (selected === undefined) return { cancelled: true as const };
    let bytes: Buffer;
    try {
      bytes = await readBoundedFile(selected, maxImportedMinutesBytes);
    } catch {
      throw new SafeMainError(
        this.#safe('CONTENT_INVALID', 'The imported minutes file is invalid or could not be read'),
      );
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new SafeMainError(
        this.#safe('CONTENT_INVALID', 'The imported minutes file is not valid UTF-8 text'),
      );
    }
    return {
      cancelled: false as const,
      data: await this.saveMinutes({ ...input, content }, ownerId),
    };
  }

  async updateConfig(input: UpdateProjectConfigDto, ownerId: number): Promise<ProjectViewDto> {
    return await this.#mutate(input, ownerId, (_owned, current) => ({
      next: updateProjectConfig(
        current,
        input.config,
        input.expectedRevision,
        systemClock.now(),
        this.#runtime,
      ),
    }));
  }

  async imagesList(input: ImagesListDto, ownerId: number): Promise<ImagesListResultDto> {
    return await this.#gate.run(() => {
      const owned = this.#owned(input.sessionId, ownerId);
      const current = owned.project.read();
      const images = current.images.map((image) => ({
        id: image.id,
        widthPx: image.ref.widthPx,
        heightPx: image.ref.heightPx,
        previewDataUrl: `data:image/jpeg;base64,${owned.project
          .readImage(image.ref)
          .toString('base64')}`,
      }));
      return Promise.resolve({ sessionId: input.sessionId, revision: current.revision, images });
    });
  }

  async imagesAdd(input: AddImagesDto, ownerId: number): Promise<ProjectViewDto> {
    return await this.#mutate(input, ownerId, (_owned, current) => {
      const artifacts = new Map<string, Uint8Array>();
      const refs = input.items.map((item) => {
        const bytes = new Uint8Array(Buffer.from(item.dataBase64, 'base64'));
        if (bytes.byteLength === 0 || bytes.byteLength > 1_200_000) {
          throw new SafeMainError(this.#contentInvalid());
        }
        const relativePath = `assets/images/${randomUUID()}.jpg`;
        artifacts.set(relativePath, bytes);
        return imageArtifact(relativePath, bytes, item.widthPx, item.heightPx);
      });
      const next = addImages(current, refs, input.expectedRevision, {
        ids: { next: () => randomUUID() },
        clock: systemClock,
        runtime: this.#runtime,
      });
      return { next, artifacts };
    });
  }

  async imagesRemove(input: RemoveImageDto, ownerId: number): Promise<ProjectViewDto> {
    return await this.#mutate(input, ownerId, (_owned, current) => ({
      next: removeImage(
        current,
        imageIdSchema.parse(input.imageId),
        input.expectedRevision,
        systemClock.now(),
        this.#runtime,
      ),
    }));
  }

  async imagesReorder(input: ReorderImagesDto, ownerId: number): Promise<ProjectViewDto> {
    return await this.#mutate(input, ownerId, (_owned, current) => ({
      next: reorderImages(
        current,
        imageIdSchema.array().parse([...input.orderedIds]),
        input.expectedRevision,
        systemClock.now(),
        this.#runtime,
      ),
    }));
  }

  async imagesClear(input: ClearImagesDto, ownerId: number): Promise<ProjectViewDto> {
    return await this.#mutate(input, ownerId, (_owned, current) => ({
      next: clearImages(current, input.expectedRevision, systemClock.now(), this.#runtime),
    }));
  }

  async preparePrompt(input: PreparePromptDto, ownerId: number): Promise<PromptPreparation> {
    return await this.#gate.run(async () => await this.preparePromptWithinGate(input, ownerId));
  }

  async preparePromptWithinGate(
    input: PreparePromptDto,
    ownerId: number,
  ): Promise<PromptPreparation> {
    const owned = this.#owned(input.sessionId, ownerId);
    const project = owned.project.read();
    this.#assertProfileWriteCompatible(project);
    this.#assertRevision(owned, input.expectedRevision);
    if (project.status !== 'active') {
      throw new SafeMainError(this.#stateConflict('Archived projects cannot prepare tasks'));
    }
    if (project.latestVersionId !== input.parentVersionId) {
      throw new SafeMainError(
        this.#stateConflict('The selected parent version is not the current latest version'),
      );
    }
    const configuredKey = await this.#credentials.readConfiguredApiKey();
    this.#assertStringsSafe([JSON.stringify(input)], configuredKey);
    const minutesContent = owned.project.readText(project.minutes.contentRef);
    const parent =
      input.parentVersionId === null
        ? undefined
        : project.versions.find((candidate) => candidate.id === input.parentVersionId);
    if (input.parentVersionId !== null && parent === undefined) {
      throw new SafeMainError(this.#notFound());
    }
    const parentContent =
      parent === undefined ? undefined : owned.project.readText(parent.contentRef);
    const branchFacts = resolveBranchFacts(project, input.parentVersionId);
    const factOverrides = resolveFactOverrides(branchFacts.factOverrides, input.factOverrides);
    const user = await this.#userConfig.get();
    const comments =
      input.kind === 'commentRevision'
        ? orderCommentSnapshots(
            project.comments.filter((comment) => comment.versionId === input.parentVersionId),
          ).map((comment) => ({
            anchor: comment.anchor,
            id: comment.id,
            createdAt: comment.createdAt,
            quotedText: comment.quotedText,
            body: comment.body,
          }))
        : [];
    if (parent !== undefined && parentContent !== undefined) {
      for (const comment of comments) {
        if (
          comment.anchor.contentSha256 !== parent.contentRef.sha256 ||
          parentContent.slice(comment.anchor.start, comment.anchor.end) !== comment.anchor.exact
        ) {
          throw new SafeMainError(this.#contentInvalid());
        }
      }
    }
    const retrieval = (() => {
      if (input.kind !== 'draftGeneration') return undefined;
      if (input.retrievalEnabled === false) return { state: 'notUsed' as const };
      if (input.retrievalReportId === undefined) return { state: 'unavailable' as const };
      const report = project.retrievalReports.find(
        (candidate) => candidate.id === input.retrievalReportId,
      );
      if (report === undefined) throw new SafeMainError(this.#notFound());
      return {
        state: report.hits.length === 0 ? ('zeroHits' as const) : ('used' as const),
        reportId: report.id,
        knowledgeVersion: report.knowledgeVersion,
        retrievalEngineVersion: report.retrievalEngineVersion,
        hits: report.hits.map((hit) => ({
          rank: hit.rank,
          referenceLabel: /^r\d{2}$/.test(hit.documentId)
            ? hit.documentId
            : `r${String(hit.rank).padStart(2, '0')}`,
          title: hit.title,
          promptExcerpt: hit.promptExcerpt,
        })),
      };
    })();
    const prepared = buildPrompt(
      {
        schemaVersion: 1,
        kind: input.kind,
        profile: project.profile,
        publisher: this.#publisher(project, minutesContent),
        minutes: {
          revisionId: project.minutes.revisionId,
          contentSha256: project.minutes.contentRef.sha256,
          content: minutesContent,
        },
        parent:
          parent === undefined || parentContent === undefined
            ? null
            : {
                versionId: parent.id,
                contentSha256: parent.contentRef.sha256,
                content: parentContent,
              },
        ...(factOverrides === undefined ? {} : { factOverrides }),
        ...(retrieval === undefined ? {} : { retrieval }),
        comments,
        config: {
          defaults: this.readDefaultGenerationConfig(project.profile),
          ...(Object.keys(user.config).length === 0 ? {} : { user: user.config }),
          ...(Object.keys(project.projectConfig).length === 0
            ? {}
            : { project: project.projectConfig }),
          ...(input.taskConfig === undefined ? {} : { task: input.taskConfig }),
        },
        ...(project.profileSnapshot === undefined
          ? this.#profileSnapshot === undefined
            ? {}
            : { profileSnapshot: this.#profileSnapshot }
          : { profileSnapshot: project.profileSnapshot }),
        writingRulesVersion:
          project.profileSnapshot?.writingRulesVersion ??
          this.#profileSnapshot?.writingRulesVersion ??
          'prompt-contract-v1',
      } as never,
      { sha256Utf8 },
    );
    this.#assertStringsSafe(
      [JSON.stringify(prepared), ...prepared.messages.map((message) => message.content)],
      configuredKey,
    );
    return prepared;
  }

  async getUserConfig(): Promise<UserConfigViewDto> {
    return await this.#gate.run(async () => await this.#userConfig.get());
  }

  async readUserConfigWithinGate(): Promise<UserConfigViewDto> {
    return await this.#userConfig.get();
  }

  async updateUserConfig(input: UpdateUserConfigDto): Promise<UserConfigViewDto> {
    return await this.#gate.run(async () => {
      this.#assertStringsSafe(
        [JSON.stringify(input)],
        await this.#credentials.readConfiguredApiKey(),
      );
      return await this.#userConfig.update(input.expectedRevision, input.config);
    });
  }

  async previewConfig(input: PreviewConfigDto, ownerId: number) {
    return await this.#gate.run(async () => {
      const owned = this.#owned(input.sessionId, ownerId);
      this.#assertRevision(owned, input.expectedRevision);
      const project = owned.project.read();
      const user = await this.#userConfig.get();
      return resolveGenerationConfig({
        profile: project.profile,
        defaults: this.readDefaultGenerationConfig(project.profile),
        user: user.config,
        project: project.projectConfig,
        ...(input.taskConfig === undefined ? {} : { task: input.taskConfig }),
      });
    });
  }

  async setArchived(input: SetArchivedDto, ownerId: number): Promise<ProjectViewDto> {
    return await this.#mutate(input, ownerId, (_owned, current) => ({
      next: input.archived
        ? archiveProject(current, input.expectedRevision, systemClock.now(), this.#runtime)
        : restoreProject(current, input.expectedRevision, systemClock.now(), this.#runtime),
    }));
  }

  async setLatestVersion(input: SetLatestVersionDto, ownerId: number): Promise<ProjectViewDto> {
    return await this.#mutate(input, ownerId, (_owned, current) => ({
      next: (() => {
        if (isActiveTask(current)) {
          throw new SafeMainError(
            this.#stateConflict('The latest version cannot change while a task is active'),
          );
        }
        return setLatestVersion(
          current,
          input.versionId,
          input.expectedRevision,
          systemClock.now(),
          this.#runtime,
        );
      })(),
    }));
  }

  async addComment(input: AddCommentDto, ownerId: number): Promise<ProjectViewDto> {
    if (input.quotedText !== input.anchor.exact) throw new SafeMainError(this.#protocolInvalid());
    return await this.#mutate(input, ownerId, (owned, current) => ({
      next: addComment(
        current,
        {
          versionId: input.versionId,
          anchor: textQuoteAnchorSchema.parse(input.anchor),
          body: input.body,
        },
        input.expectedRevision,
        {
          ids,
          clock: systemClock,
          runtime: this.#runtime,
          artifacts: { readText: (ref) => owned.project.readText(ref) },
        },
      ),
    }));
  }

  async editComment(input: EditCommentDto, ownerId: number): Promise<ProjectViewDto> {
    if (input.quotedText !== input.anchor.exact) throw new SafeMainError(this.#protocolInvalid());
    return await this.#mutate(input, ownerId, (owned, current) => {
      const comment = current.comments.find((candidate) => candidate.id === input.commentId);
      if (comment === undefined) throw new SafeMainError(this.#notFound());
      if (comment.revision !== input.expectedCommentRevision)
        throw new SafeMainError(this.#conflict());
      return {
        next: editComment(
          current,
          {
            commentId: commentIdSchema.parse(input.commentId),
            anchor: textQuoteAnchorSchema.parse(input.anchor),
            body: input.body,
          },
          input.expectedRevision,
          systemClock.now(),
          { readText: (ref) => owned.project.readText(ref) },
          this.#runtime,
        ),
      };
    });
  }

  async deleteComment(input: DeleteCommentDto, ownerId: number): Promise<ProjectViewDto> {
    return await this.#mutate(input, ownerId, (_owned, current) => {
      const comment = current.comments.find((candidate) => candidate.id === input.commentId);
      if (comment === undefined) throw new SafeMainError(this.#notFound());
      if (comment.revision !== input.expectedCommentRevision)
        throw new SafeMainError(this.#conflict());
      return {
        next: deleteComment(
          current,
          { commentId: commentIdSchema.parse(input.commentId) },
          input.expectedRevision,
          systemClock.now(),
          this.#runtime,
        ),
      };
    });
  }

  getOwned(
    sessionId: SessionId,
    ownerId: number,
  ): { project: ProjectSession; aggregate: ProjectAggregateV1 } {
    const owned = this.#owned(sessionId, ownerId);
    return { project: owned.project, aggregate: owned.project.read() };
  }

  async setCredentialIfProjectsSafe<Result>(
    apiKey: string,
    persist: () => Promise<Result>,
  ): Promise<Result> {
    return await this.#gate.run(async () => {
      this.#assertStringsSafe([JSON.stringify(await this.#userConfig.get())], apiKey);
      for (const owned of this.#sessions.values()) {
        await owned.project.refresh();
        this.#assertProjectSafe(owned.project, apiKey);
      }
      return await persist();
    });
  }

  view(sessionId: SessionId, ownerId: number): ProjectViewDto {
    return this.#view(this.#owned(sessionId, ownerId));
  }

  async closeAll(): Promise<void> {
    await this.#gate.run(async () => {
      for (const token of [...this.#pendingRecoveries.keys()]) this.#clearPendingRecovery(token);
      this.#openAttempts.clear();
      const sessions = [...this.#sessions.values()];
      this.#sessions.clear();
      this.#roots.clear();
      await Promise.all(
        sessions.map(async (owned) => await owned.project.close().catch(() => undefined)),
      );
    });
  }

  async #finishOpen(project: ProjectSession, ownerId: number): Promise<ProjectViewDto> {
    this.#assertProfileCompatible(project.read());
    await this.#assertSessionSafe(project);
    await this.#recoverInterruptedTask(project);
    await this.#assertSessionSafe(project);
    return this.#view(this.#register(project, ownerId));
  }

  #beginOpenAttempt(ownerId: number): number {
    this.#invalidatePendingRecoveries(ownerId);
    const attempt = (this.#openAttempts.get(ownerId) ?? 0) + 1;
    this.#openAttempts.set(ownerId, attempt);
    return attempt;
  }

  #rememberRecovery(ownerId: number, canonicalRoot: string, observedInstanceId: string) {
    this.#invalidatePendingRecoveries(ownerId);
    const token = randomUUID();
    const expiresAtMs = Date.now() + lockRecoveryTtlMs;
    const expiryTimer = setTimeout(() => this.#clearPendingRecovery(token), lockRecoveryTtlMs);
    expiryTimer.unref();
    this.#pendingRecoveries.set(token, {
      token,
      ownerId,
      canonicalRoot,
      observedInstanceId,
      expiresAtMs,
      expiryTimer,
    });
    return projectLockRecoveryDescriptorSchema.parse({
      recoveryToken: token,
      observedInstanceId,
    });
  }

  #invalidatePendingRecoveries(ownerId: number): void {
    for (const pending of this.#pendingRecoveries.values()) {
      if (pending.ownerId === ownerId) this.#clearPendingRecovery(pending.token);
    }
  }

  #clearPendingRecovery(token: string): void {
    const pending = this.#pendingRecoveries.get(token);
    if (pending === undefined) return;
    clearTimeout(pending.expiryTimer);
    this.#pendingRecoveries.delete(token);
  }

  async #recoverInterruptedTask(project: ProjectSession): Promise<void> {
    const current = project.read();
    const interrupted = current.tasks.find((task) =>
      ['queued', 'preparing', 'requesting', 'processing', 'reviewing', 'saving'].includes(
        task.status,
      ),
    );
    if (interrupted === undefined) return;
    const error = safeAppErrorSchema.parse({
      code: 'TASK_INTERRUPTED',
      occurredAt: systemClock.now(),
      safeMessage: 'The task was interrupted when the application stopped',
      retryable: true,
    });
    const next = transitionTask(
      current,
      interrupted.id,
      { status: 'failed', error },
      current.revision,
      error.occurredAt,
      this.#runtime,
    );
    await project.commit({
      transactionId: makeTransactionId(),
      commitId: makeCommitId(),
      expectedRevision: current.revision,
      expectedHeadCommitId: project.headCommitId,
      nextAggregate: next,
    });
  }

  async #mutate<T extends { sessionId: SessionId; expectedRevision: number }>(
    input: T,
    ownerId: number,
    operation: (
      owned: OwnedSession,
      current: ProjectAggregateV1,
    ) => {
      next: ProjectAggregateV1;
      artifacts?: ReadonlyMap<string, Uint8Array | string>;
    },
  ): Promise<ProjectViewDto> {
    return await this.#gate.run(async () => {
      const owned = this.#owned(input.sessionId, ownerId);
      const current = owned.project.read();
      this.#assertRevision(owned, input.expectedRevision);
      this.#assertProfileWriteCompatible(current);
      const configuredKey = await this.#credentials.readConfiguredApiKey();
      this.#assertStringsSafe([JSON.stringify(input)], configuredKey);
      const { next, artifacts } = operation(owned, current);
      if (next === current) return this.#view(owned);
      this.#assertAggregateSafe(next, artifacts, configuredKey);
      await owned.project.commit({
        transactionId: makeTransactionId(),
        commitId: makeCommitId(),
        expectedRevision: input.expectedRevision,
        expectedHeadCommitId: owned.project.headCommitId,
        nextAggregate: next,
        ...(artifacts === undefined ? {} : { artifacts }),
      });
      return this.#view(owned);
    });
  }

  #register(project: ProjectSession, ownerId: number): OwnedSession {
    const sessionId = sessionIdSchema.parse(randomUUID());
    const owned = { sessionId, ownerId, canonicalRoot: project.root, project, closing: false };
    this.#sessions.set(sessionId, owned);
    this.#roots.set(project.root.toLocaleLowerCase('en-US'), owned);
    return owned;
  }

  async #assertSessionSafe(project: ProjectSession): Promise<void> {
    this.#assertProjectSafe(project, await this.#credentials.readConfiguredApiKey());
  }

  #assertProjectSafe(project: ProjectSession, exactSecret: string | undefined): void {
    const aggregate = project.read();
    const text = [
      project.readText(aggregate.minutes.contentRef),
      ...aggregate.prompts.flatMap((prompt) =>
        prompt.messages.map((message) => project.readText(message.contentRef)),
      ),
      ...aggregate.versions.map((version) => project.readText(version.contentRef)),
    ];
    this.#assertStringsSafe([JSON.stringify(aggregate), ...text], exactSecret);
  }

  #assertAggregateSafe(
    aggregate: ProjectAggregateV1,
    artifacts: ReadonlyMap<string, Uint8Array | string> | undefined,
    exactSecret: string | undefined,
  ): void {
    const values = [JSON.stringify(aggregate)];
    for (const value of artifacts?.values() ?? []) {
      if (typeof value !== 'string') continue;
      values.push(value);
    }
    this.#assertStringsSafe(values, exactSecret);
  }

  #assertProfileCompatible(project: ProjectAggregateV1): void {
    const expected = this.#profileSnapshot;
    if (expected === undefined || project.profileSnapshot === undefined) return;
    if (JSON.stringify(project.profileSnapshot) !== JSON.stringify(expected)) {
      throw new SafeMainError(
        this.#stateConflict('This project belongs to a different institution profile'),
      );
    }
  }

  #assertProfileWriteCompatible(project: ProjectAggregateV1): void {
    const expected = this.#profileSnapshot;
    if (expected === undefined) return;
    if (project.profileSnapshot === undefined) {
      throw new SafeMainError(
        this.#stateConflict(
          'This legacy project is read-only until it is migrated to the current institution profile',
        ),
      );
    }
    this.#assertProfileCompatible(project);
  }

  #assertStringsSafe(values: readonly string[], exactSecret: string | undefined): void {
    if (containsSecretMaterial(values, exactSecret === undefined ? [] : [exactSecret])) {
      throw new SafeMainError(this.#contentInvalid());
    }
  }

  #owned(sessionId: SessionId, ownerId: number): OwnedSession {
    const owned = this.#sessions.get(sessionId);
    if (owned === undefined || owned.ownerId !== ownerId || owned.closing)
      throw new SafeMainError(this.#senderRejected());
    return owned;
  }

  #assertRevision(owned: OwnedSession, expectedRevision: number): void {
    if (owned.project.read().revision !== expectedRevision)
      throw new SafeMainError(this.#conflict());
  }

  readDefaultGenerationConfig(profile: ProjectAggregateV1['profile']): GenerationConfigValues {
    const snapshot = this.#profileSnapshot;
    let targetChannel = DEFAULT_GENERATION_CONFIG.targetChannel;
    if (snapshot !== undefined) {
      if (profile === 'official' && snapshot.targetChannels[0] !== undefined) {
        targetChannel = snapshot.targetChannels[0];
      } else if (profile === 'other') {
        targetChannel = '目标平台';
      }
    }
    return {
      ...DEFAULT_GENERATION_CONFIG,
      targetChannel,
      ...(snapshot?.defaultWordCountRecommendation !== undefined
        ? { maxWords: snapshot.defaultWordCountRecommendation }
        : {}),
    };
  }

  #publisher(project: ProjectAggregateV1, minutes: string): string {
    if (project.profile === 'official') {
      const effective = project.profileSnapshot ?? this.#profileSnapshot;
      return effective?.officialPublisher ?? '示例学院';
    }
    const section = /\[主体\]\s*\n+([^\n]+)/u.exec(minutes)?.[1]?.trim();
    const signature = /落款使用[“"]([^”"]+)[”"]/u.exec(minutes)?.[1]?.trim();
    const publisher = section ?? signature;
    if (publisher === undefined || publisher.length === 0) {
      throw new SafeMainError(
        this.#stateConflict('The publishing organization is missing from the minutes'),
      );
    }
    return publisher;
  }

  #view(owned: OwnedSession): ProjectViewDto {
    const project = owned.project.read();
    return {
      sessionId: owned.sessionId,
      revision: project.revision,
      projectId: project.projectId,
      name: project.name,
      profile: project.profile,
      status: project.status,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      ...(project.archivedAt === undefined ? {} : { archivedAt: project.archivedAt }),
      latestVersionId: project.latestVersionId,
      projectConfig: project.projectConfig,
      minutes: {
        minuteId: project.minutes.minuteId,
        revisionId: project.minutes.revisionId,
        createdAt: project.minutes.createdAt,
        content: owned.project.readText(project.minutes.contentRef),
      },
      versions: project.versions.map((version) => ({
        id: version.id,
        createdAt: version.createdAt,
        parentVersionId: version.parentVersionId,
        createdBy: version.createdBy,
        taskId: version.taskId,
        contentSha256: version.contentRef.sha256,
        ...(version.factOverrides === undefined ? {} : { factOverrides: version.factOverrides }),
        content: owned.project.readText(version.contentRef),
      })),
      comments: project.comments,
      prompts: project.prompts.map((prompt) => ({
        id: prompt.id,
        createdAt: prompt.createdAt,
        purpose: prompt.purpose,
        editedByUser: prompt.editedByUser,
        upstream: prompt.upstream,
        messages: prompt.messages.map((message) => ({
          role: message.role,
          content: owned.project.readText(message.contentRef),
        })),
      })),
      tasks: project.tasks.map((task) => ({
        id: task.id,
        kind: task.kind,
        status: task.status,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        parentVersionId: task.parentVersionId,
        promptId: task.promptId,
        history: task.history,
        configSnapshot: task.configSnapshot,
        ...(task.factOverrides === undefined ? {} : { factOverrides: task.factOverrides }),
        minutes: {
          revisionId: task.minutesSnapshot.revisionId,
          sha256: task.minutesSnapshot.contentRef.sha256,
        },
        retrieval: (() => {
          if (task.retrievalReportId === undefined)
            return {
              state:
                task.retrievalUnavailable === true
                  ? ('unavailable' as const)
                  : ('notUsed' as const),
            };
          const report = project.retrievalReports.find(
            (candidate) => candidate.id === task.retrievalReportId,
          );
          if (report === undefined) return { state: 'unavailable' as const };
          return {
            state: report.hits.length === 0 ? ('zeroHits' as const) : ('used' as const),
            reportId: report.id,
            knowledgeVersion: report.knowledgeVersion,
            hitCount: report.hits.length,
          };
        })(),
        comments: {
          count: task.commentSnapshot.length,
          sha256: fingerprintCommentSnapshot(
            task.commentSnapshot.map((comment) => ({
              anchor: comment.anchor,
              id: comment.id,
              createdAt: comment.createdAt,
              quotedText: comment.quotedText,
              body: comment.body,
            })),
            { sha256Utf8 },
          ),
        },
        reviewEnabled: task.reviewEnabled === true,
        ...('resultVersionId' in task ? { resultVersionId: task.resultVersionId } : {}),
        ...('error' in task ? { error: task.error } : {}),
      })),
      retrievalReports: project.retrievalReports.map((report) => ({
        id: report.id,
        createdAt: report.createdAt,
        knowledgeVersion: report.knowledgeVersion,
        hitCount: report.hits.length,
      })),
      exportRecords: project.exportRecords.map(exportRecordView),
      images: project.images.map((image) => ({
        id: image.id,
        widthPx: image.ref.widthPx,
        heightPx: image.ref.heightPx,
      })),
    };
  }

  #documentSafeError(
    code:
      | 'DOCUMENT_CONTENT_INVALID'
      | 'DOCUMENT_GENERATION_FAILED'
      | 'EXPORT_PATH_INVALID'
      | 'EXPORT_NOT_WRITABLE'
      | 'EXPORT_DISK_FULL'
      | 'EXPORT_ATOMIC_REPLACE_FAILED'
      | 'EXPORT_IO_ERROR',
    retryable: boolean,
    safeMessage = 'The document export could not be completed',
    diagnosticId?: string,
  ) {
    return safeAppErrorSchema.parse({
      code,
      occurredAt: systemClock.now(),
      safeMessage,
      retryable,
      ...(diagnosticId === undefined ? {} : { diagnosticId }),
    });
  }

  #safe(
    code:
      | 'IPC_SENDER_REJECTED'
      | 'IPC_PROTOCOL_INVALID'
      | 'PROJECT_CONFLICT'
      | 'PROJECT_NOT_FOUND'
      | 'PROJECT_STATE_CONFLICT'
      | 'CONTENT_INVALID',
    message: string,
  ) {
    return {
      code,
      occurredAt: timestampSchema.parse(new Date().toISOString()),
      safeMessage: message,
      retryable: false,
    };
  }
  #senderRejected() {
    return this.#safe('IPC_SENDER_REJECTED', 'The project session is not owned by this page');
  }
  #protocolInvalid() {
    return this.#safe('IPC_PROTOCOL_INVALID', 'The project request is invalid');
  }
  #contentInvalid() {
    return this.#safe('CONTENT_INVALID', 'Credential material cannot be stored in a project');
  }
  #resourceUnavailable() {
    return safeAppErrorSchema.parse({
      code: 'RESOURCE_UNAVAILABLE',
      occurredAt: timestampSchema.parse(new Date().toISOString()),
      safeMessage: 'The built-in knowledge resources are not available',
      retryable: false,
    });
  }
  #stateConflict(message: string) {
    return this.#safe('PROJECT_STATE_CONFLICT', message);
  }
  #conflict() {
    return this.#safe('PROJECT_CONFLICT', 'The project changed before the operation');
  }
  #notFound() {
    return this.#safe('PROJECT_NOT_FOUND', 'The requested project entity was not found');
  }
}
