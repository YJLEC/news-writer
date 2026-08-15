import { describe, expect, it } from 'vitest';

import {
  IPC_CHANNELS,
  IPC_EVENT_CONTRACTS,
  IPC_INVOKE_CONTRACTS,
  IPC_MAX_STRUCTURED_BYTES,
  IPC_PROTOCOL_VERSION,
  addCommentDtoSchema,
  ipcResultSchema,
  projectViewDtoSchema,
  promptPreparationDtoSchema,
  startTaskDtoSchema,
  taskStatusEventDtoSchema,
} from './ipc.js';

const ids = {
  session: '00000000-0000-4000-8000-000000000001',
  project: '00000000-0000-4000-8000-000000000002',
  minute: '00000000-0000-4000-8000-000000000003',
  minuteRevision: '00000000-0000-4000-8000-000000000004',
  version: '00000000-0000-4000-8000-000000000005',
  comment: '00000000-0000-4000-8000-000000000006',
  prompt: '00000000-0000-4000-8000-000000000007',
  task: '00000000-0000-4000-8000-000000000008',
  retrieval: '00000000-0000-4000-8000-000000000009',
  recovery: '00000000-0000-4000-8000-000000000010',
  lockInstance: '00000000-0000-4000-8000-000000000011',
  export: '00000000-0000-4000-8000-000000000012',
} as const;
const at = '2026-08-09T01:02:03.123Z';
const anchor = {
  kind: 'textQuote',
  contentSha256: 'a'.repeat(64),
  start: 0,
  end: 1,
  exact: '稿',
  prefix: '',
  suffix: '',
} as const;
const session = { sessionId: ids.session, expectedRevision: 0 };
const hash = 'b'.repeat(64);
const resolvedConfig = {
  schemaVersion: 1,
  provider: 'deepseek',
  profile: 'official',
  values: {
    model: 'deepseek-v4-pro',
    reasoningEffort: 'medium',
    targetChannel: '学院网站',
    maxWords: 900,
    requestTimeoutMs: 120_000,
  },
  sources: {
    model: 'default',
    reasoningEffort: 'default',
    targetChannel: 'default',
    maxWords: 'default',
    requestTimeoutMs: 'default',
  },
} as const;
const trace = {
  minutes: { revisionId: ids.minuteRevision, sha256: hash },
  parent: null,
  retrieval: { state: 'unavailable' },
  comments: { count: 0, sha256: hash },
  writingRulesVersion: 'writing-v1',
  profileSnapshot: {
    profileId: 'profile_synthetic-public',
    profileVersion: 'v1',
    writingRulesVersion: 'writing-v1',
    promptContractVersion: 'prompt-contract-v1',
    documentStyleVersion: 'document-style-v1',
    knowledgeVersion: 'kw_synthetic_v1',
    resourceHash: hash,
    officialPublisher: 'Synthetic Publisher',
    targetChannels: ['Website'],
    defaultWordCountRecommendation: 1200,
    rules: ['Use only supplied facts.'],
    promptSections: {
      initialDraft: 'Prepare an initial draft.',
      secondReview: 'Review the draft.',
      commentRevision: 'Apply comments to the draft.',
    },
  },
} as const;
const project = {
  sessionId: ids.session,
  revision: 0,
  projectId: ids.project,
  name: '测试项目',
  profile: 'official',
  status: 'active',
  createdAt: at,
  updatedAt: at,
  latestVersionId: ids.version,
  projectConfig: {},
  minutes: {
    minuteId: ids.minute,
    revisionId: ids.minuteRevision,
    createdAt: at,
    content: '纪要',
  },
  versions: [
    {
      id: ids.version,
      createdAt: at,
      parentVersionId: null,
      createdBy: 'draftGeneration',
      taskId: ids.task,
      contentSha256: hash,
      content: '稿',
    },
  ],
  comments: [
    {
      id: ids.comment,
      revision: 0,
      versionId: ids.version,
      anchor,
      quotedText: '稿',
      body: '修改',
      createdAt: at,
      updatedAt: at,
    },
  ],
  prompts: [
    {
      id: ids.prompt,
      createdAt: at,
      purpose: 'draftGeneration',
      messages: [{ role: 'user', content: '写稿' }],
      editedByUser: false,
      upstream: {
        promptInputFingerprint: hash,
        currentInputFingerprint: hash,
        staleResolution: 'current',
      },
    },
  ],
  tasks: [
    {
      id: ids.task,
      kind: 'draftGeneration',
      status: 'succeeded',
      createdAt: at,
      updatedAt: at,
      parentVersionId: null,
      promptId: ids.prompt,
      history: [{ status: 'succeeded', at }],
      configSnapshot: resolvedConfig,
      minutes: trace.minutes,
      retrieval: trace.retrieval,
      comments: trace.comments,
      resultVersionId: ids.version,
    },
  ],
  retrievalReports: [
    {
      id: ids.retrieval,
      createdAt: at,
      knowledgeVersion: 'synthetic-v1',
      hitCount: 1,
    },
  ],
  exportRecords: [],
} as const;

const requests: Record<string, unknown> = {
  [IPC_CHANNELS.runtimeGetInfo]: {},
  [IPC_CHANNELS.authGetStatus]: {},
  [IPC_CHANNELS.authSetDeepSeekApiKey]: { apiKey: 'test-key' },
  [IPC_CHANNELS.authClearDeepSeekApiKey]: { confirmed: true },
  [IPC_CHANNELS.projectsCreateWithDialog]: {
    name: '测试项目',
    profile: 'official',
    initialMinutes: '纪要',
  },
  [IPC_CHANNELS.projectsOpenWithDialog]: {},
  [IPC_CHANNELS.projectsResumeOwned]: {},
  [IPC_CHANNELS.projectsRecoverOpen]: { recoveryToken: ids.recovery, confirmed: true },
  [IPC_CHANNELS.projectsClose]: session,
  [IPC_CHANNELS.projectsRefresh]: session,
  [IPC_CHANNELS.projectsSaveMinutes]: { ...session, content: '新纪要' },
  [IPC_CHANNELS.projectsImportMinutesWithDialog]: session,
  [IPC_CHANNELS.projectsUpdateConfig]: { ...session, config: { maxWords: 800 } },
  [IPC_CHANNELS.projectsSetArchived]: { ...session, archived: true },
  [IPC_CHANNELS.projectsSetLatestVersion]: { ...session, versionId: ids.version },
  [IPC_CHANNELS.promptsPrepare]: {
    ...session,
    kind: 'draftGeneration',
    parentVersionId: null,
  },
  [IPC_CHANNELS.settingsGetUserConfig]: {},
  [IPC_CHANNELS.settingsUpdateUserConfig]: { expectedRevision: 0, config: { maxWords: 800 } },
  [IPC_CHANNELS.settingsPreviewConfig]: { ...session },
  [IPC_CHANNELS.commentsAdd]: {
    ...session,
    versionId: ids.version,
    anchor,
    quotedText: '稿',
    body: '修改',
  },
  [IPC_CHANNELS.commentsEdit]: {
    ...session,
    commentId: ids.comment,
    expectedCommentRevision: 0,
    anchor,
    quotedText: '稿',
    body: '修改',
  },
  [IPC_CHANNELS.commentsDelete]: {
    ...session,
    commentId: ids.comment,
    expectedCommentRevision: 0,
  },
  [IPC_CHANNELS.retrievalSearch]: { ...session, query: '活动', topK: 5 },
  [IPC_CHANNELS.tasksStart]: {
    ...session,
    kind: 'draftGeneration',
    parentVersionId: null,
    messages: [
      { role: 'system', content: '系统约束' },
      { role: 'user', content: '写稿' },
    ],
    editedByUser: false,
    editWarningAcknowledged: false,
    promptInputFingerprint: hash,
    staleResolution: 'current',
    acknowledgedRiskCodes: [],
  },
  [IPC_CHANNELS.tasksCancel]: { ...session, taskId: ids.task },
  [IPC_CHANNELS.documentsExportWithDialog]: { ...session, versionId: ids.version },
};

const data: Record<string, unknown> = {
  [IPC_CHANNELS.runtimeGetInfo]: {
    appVersion: '0.1.0',
    electronVersion: '43.3.0',
    chromiumVersion: '142.0.0',
    projectSchemaVersion: 1,
    knowledgeVersion: null,
    platform: 'win32',
    arch: 'x64',
  },
  [IPC_CHANNELS.authGetStatus]: { provider: 'deepseek', status: 'notConfigured' },
  [IPC_CHANNELS.authSetDeepSeekApiKey]: {
    provider: 'deepseek',
    status: 'configured',
    updatedAt: at,
  },
  [IPC_CHANNELS.authClearDeepSeekApiKey]: { provider: 'deepseek', status: 'notConfigured' },
  [IPC_CHANNELS.projectsCreateWithDialog]: { cancelled: false, data: project },
  [IPC_CHANNELS.projectsOpenWithDialog]: {
    cancelled: false,
    recoveryRequired: {
      recoveryToken: ids.recovery,
      observedInstanceId: ids.lockInstance,
    },
  },
  [IPC_CHANNELS.projectsResumeOwned]: { state: 'resumed', project },
  [IPC_CHANNELS.projectsRecoverOpen]: project,
  [IPC_CHANNELS.projectsClose]: { closed: true },
  [IPC_CHANNELS.projectsRefresh]: project,
  [IPC_CHANNELS.projectsSaveMinutes]: project,
  [IPC_CHANNELS.projectsImportMinutesWithDialog]: { cancelled: false, data: project },
  [IPC_CHANNELS.projectsUpdateConfig]: project,
  [IPC_CHANNELS.projectsSetArchived]: project,
  [IPC_CHANNELS.projectsSetLatestVersion]: project,
  [IPC_CHANNELS.promptsPrepare]: {
    schemaVersion: 1,
    purpose: 'draftGeneration',
    messages: [
      { role: 'system', content: '系统约束' },
      { role: 'user', content: '写稿' },
    ],
    inputFingerprint: hash,
    resolvedConfig,
    factCheck: {
      date: { status: 'present', evidence: '2099年1月1日', source: 'detected' },
      location: { status: 'missing', source: 'detected' },
      organizer: { status: 'missing', source: 'detected' },
      time: { status: 'missing', source: 'detected' },
      blocking: true,
    },
    risks: [{ code: 'MISSING_FACTS', severity: 'blocking', message: '缺少事实' }],
    trace,
  },
  [IPC_CHANNELS.settingsGetUserConfig]: { revision: 0, config: {} },
  [IPC_CHANNELS.settingsUpdateUserConfig]: { revision: 1, config: { maxWords: 800 } },
  [IPC_CHANNELS.settingsPreviewConfig]: resolvedConfig,
  [IPC_CHANNELS.commentsAdd]: project,
  [IPC_CHANNELS.commentsEdit]: project,
  [IPC_CHANNELS.commentsDelete]: project,
  [IPC_CHANNELS.retrievalSearch]: {
    reportId: ids.retrieval,
    knowledgeVersion: 'synthetic-v1',
    retrievalEngineVersion: 'bm25-v1',
    hits: [{ rank: 1, documentId: 'doc-1', title: '参考稿', score: 1, promptExcerpt: '摘录' }],
    missingFacts: [],
    project,
  },
  [IPC_CHANNELS.tasksStart]: project.tasks[0],
  [IPC_CHANNELS.tasksCancel]: { disposition: 'accepted' },
  [IPC_CHANNELS.documentsExportWithDialog]: {
    cancelled: false,
    project,
    record: {
      id: ids.export,
      versionId: ids.version,
      attemptedAt: at,
      completedAt: at,
      fileName: '20260810测试.docx',
      status: 'succeeded',
      templateVersion: 'standard_business_brief.zh_news_a4.v1',
      outputSha256: hash,
      byteLength: 1024,
    },
  },
};

describe('IPC contracts', () => {
  it('has a unique, fixed channel for every invoke and event', () => {
    const names = Object.values(IPC_CHANNELS);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(IPC_INVOKE_CONTRACTS)).toHaveLength(26);
    expect(Object.keys(IPC_EVENT_CONTRACTS)).toEqual([IPC_CHANNELS.tasksStatusEvent]);
    expect(names.every((name) => name.startsWith('nw:v1:'))).toBe(true);
  });

  it('positively parses every request and successful result contract', () => {
    for (const [channel, contract] of Object.entries(IPC_INVOKE_CONTRACTS)) {
      expect(contract.request.safeParse(requests[channel]).success, channel).toBe(true);
      expect(
        contract.result.safeParse({
          protocolVersion: IPC_PROTOCOL_VERSION,
          ok: true,
          data: data[channel],
        }).success,
        channel,
      ).toBe(true);
    }
  });

  it('rejects unknown request fields on every channel', () => {
    for (const [channel, contract] of Object.entries(IPC_INVOKE_CONTRACTS)) {
      expect(
        contract.request.safeParse({ ...(requests[channel] as object), injected: true }).success,
        channel,
      ).toBe(false);
    }
  });

  it('keeps owner-session resume request and result variants strict', () => {
    const contract = IPC_INVOKE_CONTRACTS[IPC_CHANNELS.projectsResumeOwned];
    expect(contract.request.safeParse({}).success).toBe(true);
    expect(contract.request.safeParse({ sessionId: ids.session }).success).toBe(false);
    expect(
      contract.result.safeParse({
        protocolVersion: IPC_PROTOCOL_VERSION,
        ok: true,
        data: { state: 'none' },
      }).success,
    ).toBe(true);
    expect(
      contract.result.safeParse({
        protocolVersion: IPC_PROTOCOL_VERSION,
        ok: true,
        data: { state: 'resumed', project },
      }).success,
    ).toBe(true);
    expect(
      contract.result.safeParse({
        protocolVersion: IPC_PROTOCOL_VERSION,
        ok: true,
        data: { state: 'none', project },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['empty', []],
    [
      'multiple users',
      [
        { role: 'user', content: '一' },
        { role: 'user', content: '二' },
      ],
    ],
    ['system', [{ role: 'system', content: '隐藏指令' }]],
    ['unknown message field', [{ role: 'user', content: '正文', injected: true }]],
  ])(
    'rejects %s messages at both V1 prepare result and start request boundaries',
    (_name, messages) => {
      expect(
        promptPreparationDtoSchema.safeParse({
          ...(data[IPC_CHANNELS.promptsPrepare] as object),
          messages,
        }).success,
      ).toBe(false);
      expect(
        startTaskDtoSchema.safeParse({
          ...(requests[IPC_CHANNELS.tasksStart] as object),
          messages,
        }).success,
      ).toBe(false);
    },
  );

  it('parses only strict versioned success/error envelopes', () => {
    const schema = ipcResultSchema(projectViewDtoSchema);
    const error = {
      code: 'IPC_PROTOCOL_INVALID',
      occurredAt: at,
      safeMessage: 'Invalid IPC message',
      retryable: false,
    };
    expect(schema.safeParse({ protocolVersion: 1, ok: false, error }).success).toBe(true);
    expect(schema.safeParse({ protocolVersion: 2, ok: false, error }).success).toBe(false);
    expect(
      schema.safeParse({ protocolVersion: 1, ok: false, error, stack: 'secret' }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ protocolVersion: 1, ok: true, data: project, extra: 1 }).success,
    ).toBe(false);
  });

  it('rejects forged identifiers, invalid revisions and bounded-text overflow', () => {
    expect(
      IPC_INVOKE_CONTRACTS[IPC_CHANNELS.projectsRecoverOpen].request.safeParse({
        recoveryToken: 'not-a-capability',
        confirmed: true,
      }).success,
    ).toBe(false);
    expect(
      IPC_INVOKE_CONTRACTS[IPC_CHANNELS.projectsRecoverOpen].request.safeParse({
        recoveryToken: ids.recovery,
        confirmed: false,
      }).success,
    ).toBe(false);
    expect(
      IPC_INVOKE_CONTRACTS[IPC_CHANNELS.projectsRefresh].request.safeParse({
        sessionId: 'not-a-capability',
        expectedRevision: 0,
      }).success,
    ).toBe(false);
    expect(
      IPC_INVOKE_CONTRACTS[IPC_CHANNELS.projectsRefresh].request.safeParse({
        sessionId: ids.session,
        expectedRevision: -1,
      }).success,
    ).toBe(false);
    expect(
      IPC_INVOKE_CONTRACTS[IPC_CHANNELS.authSetDeepSeekApiKey].request.safeParse({
        apiKey: 'x'.repeat(4097),
      }).success,
    ).toBe(false);
    expect(
      IPC_INVOKE_CONTRACTS[IPC_CHANNELS.authSetDeepSeekApiKey].request.safeParse({
        apiKey: '  \t ',
      }).success,
    ).toBe(false);
    expect(
      addCommentDtoSchema.safeParse({
        ...(requests[IPC_CHANNELS.commentsAdd] as Record<string, unknown>),
        body: 'x'.repeat(20_001),
      }).success,
    ).toBe(false);
  });

  it('accepts structured fact overrides and rejects malformed decisions', () => {
    const request = requests[IPC_CHANNELS.promptsPrepare] as Record<string, unknown>;
    expect(
      IPC_INVOKE_CONTRACTS[IPC_CHANNELS.promptsPrepare].request.safeParse({
        ...request,
        factOverrides: {
          date: { mode: 'manual', value: '2026年8月' },
          location: { mode: 'none' },
          organizer: { mode: 'auto' },
        },
      }).success,
    ).toBe(true);
    expect(
      IPC_INVOKE_CONTRACTS[IPC_CHANNELS.promptsPrepare].request.safeParse({
        ...request,
        factOverrides: { date: { mode: 'none', value: '不应有值' } },
      }).success,
    ).toBe(false);
    expect(
      IPC_INVOKE_CONTRACTS[IPC_CHANNELS.promptsPrepare].request.safeParse({
        ...request,
        factOverrides: { date: { mode: 'manual', value: '   ' } },
      }).success,
    ).toBe(false);
  });

  it('accepts production profile snapshots and keeps their nested fields strict', () => {
    const result = data[IPC_CHANNELS.promptsPrepare] as Record<string, unknown>;
    expect(promptPreparationDtoSchema.safeParse(result).success).toBe(true);
    const traceWithInvalidHash = {
      ...(result.trace as Record<string, unknown>),
      profileSnapshot: {
        ...(result.trace as { profileSnapshot: Record<string, unknown> }).profileSnapshot,
        resourceHash: 'not-a-sha256',
      },
    };
    expect(
      promptPreparationDtoSchema.safeParse({ ...result, trace: traceWithInvalidHash }).success,
    ).toBe(false);
    expect(
      promptPreparationDtoSchema.safeParse({
        ...result,
        trace: { ...(result.trace as Record<string, unknown>), writingRulesVersion: '' },
      }).success,
    ).toBe(false);
  });

  it('enforces a UTF-8 byte limit for the complete structured payload', () => {
    const schema = ipcResultSchema(projectViewDtoSchema);
    const largeContent = 'x'.repeat(6 * 1024 * 1024);
    const oversized = {
      ...project,
      versions: [1, 2, 3].map((suffix) => ({
        ...project.versions[0],
        id: `00000000-0000-4000-8000-00000000000${suffix}`,
        content: largeContent,
      })),
    };
    expect(JSON.stringify(oversized).length).toBeGreaterThan(IPC_MAX_STRUCTURED_BYTES);
    expect(
      schema.safeParse({ protocolVersion: IPC_PROTOCOL_VERSION, ok: true, data: oversized })
        .success,
    ).toBe(false);
  });

  it('rejects custom-prototype payloads at top-level and nested boundaries', () => {
    class PrototypePayload {}
    const topLevel = Object.assign(new PrototypePayload(), session);
    expect(
      IPC_INVOKE_CONTRACTS[IPC_CHANNELS.projectsRefresh].request.safeParse(topLevel).success,
    ).toBe(false);

    const nested = Object.assign(new PrototypePayload(), { maxWords: 800 });
    expect(
      IPC_INVOKE_CONTRACTS[IPC_CHANNELS.projectsUpdateConfig].request.safeParse({
        ...session,
        config: nested,
      }).success,
    ).toBe(false);
  });

  it('parses the strict safe task event and rejects content-bearing events', () => {
    const event = {
      sessionId: ids.session,
      taskId: ids.task,
      status: 'processing',
      occurredAt: at,
    };
    expect(taskStatusEventDtoSchema.safeParse(event).success).toBe(true);
    expect(taskStatusEventDtoSchema.safeParse({ ...event, prompt: 'secret' }).success).toBe(false);
    expect(IPC_EVENT_CONTRACTS[IPC_CHANNELS.tasksStatusEvent].safeParse(event).success).toBe(true);
  });
});
