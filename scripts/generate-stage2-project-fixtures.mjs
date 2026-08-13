import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  addComment,
  commitSuccessfulVersion,
  createProject,
  editComment,
  queueTask,
  recordExport,
  recordRetrieval,
  setLatestVersion,
  transitionTask,
} from '../packages/domain/dist/index.js';
import { createProjectOnDisk, sha256 } from '../packages/project/dist/index.js';
import {
  projectRelativePathSchema,
  timestampSchema,
  versionIdSchema,
} from '../packages/shared/dist/index.js';

const fixtureRoot = path.resolve('tests/fixtures/projects');

const uuid = (namespace, value) =>
  `${namespace.toString(16).padStart(8, '0')}-0000-4000-8000-${value.toString().padStart(12, '0')}`;

class FixtureIds {
  constructor(namespace) {
    this.namespace = namespace;
    this.nextValue = 1;
  }

  next() {
    return uuid(this.namespace, this.nextValue++);
  }

  peek(offset = 0) {
    return uuid(this.namespace, this.nextValue + offset);
  }
}

class FixtureClock {
  constructor(hour) {
    this.hour = hour;
    this.tick = 0;
  }

  now() {
    const seconds = this.tick++;
    const minute = Math.floor(seconds / 60);
    const second = seconds % 60;
    return timestampSchema.parse(
      `2026-08-09T${this.hour.toString().padStart(2, '0')}:${minute
        .toString()
        .padStart(2, '0')}:${second.toString().padStart(2, '0')}.0000000Z`,
    );
  }
}

const textRef = (relativePath, text, mediaType = 'text/markdown') => {
  const bytes = Buffer.from(text, 'utf8');
  return {
    relativePath: projectRelativePathSchema.parse(relativePath),
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    mediaType,
    encoding: 'utf-8',
  };
};

const defaults = {
  model: 'deepseek-chat',
  reasoningEffort: 'medium',
  targetChannel: '学院网站',
  maxWords: 900,
  requestTimeoutMs: 120000,
};

const runtime = {
  appVersion: '0.1.0-fixture',
  electronVersion: '43.3.0',
  chromiumVersion: '150.0.0',
};

const createFixture = async (name, namespace, hour) => {
  const ids = new FixtureIds(namespace);
  const clock = new FixtureClock(hour);
  const minutesText = '2026年8月9日，合成学院在测试会场举办规范写作交流活动。\n';
  const minutesRef = textRef(`content/minutes/${ids.peek(1)}/${ids.peek(2)}.md`, minutesText);
  let project = createProject(
    {
      name,
      profile: 'official',
      minutesContentRef: minutesRef,
      runtime,
    },
    { ids, clock, runtime },
  );
  const target = path.join(fixtureRoot, name);
  const session = await createProjectOnDisk({
    root: target,
    appVersion: '0.1.0-fixture',
    aggregate: project,
    artifacts: new Map([[minutesRef.relativePath, minutesText]]),
    transactionId: uuid(namespace, 900001),
    commitId: uuid(namespace, 900002),
  });
  let commitValue = 910000;
  const commit = async (next, artifacts = new Map(), operation = 'update', details) => {
    project = await session.commit({
      transactionId:
        operation === 'completeTaskWithVersion'
          ? details.successTransactionId
          : uuid(namespace, commitValue++),
      commitId: uuid(namespace, commitValue++),
      expectedRevision: project.revision,
      expectedHeadCommitId: session.headCommitId,
      operation,
      ...(details === undefined ? {} : { details }),
      nextAggregate: next,
      artifacts,
    });
  };
  const contents = new Map([[minutesRef.relativePath, minutesText]]);

  const generate = async (kind, number) => {
    const taskId = ids.peek(1);
    const promptText = `请根据本项目合成资料生成第${number}个测试版本。\n`;
    const promptRef = textRef(`content/prompts/${taskId}/0.txt`, promptText, 'text/plain');
    let next = queueTask(
      project,
      {
        kind,
        messages: [{ role: 'user', contentRef: promptRef }],
        editedByUser: false,
        upstream: {
          promptInputFingerprint: promptRef.sha256,
          currentInputFingerprint: promptRef.sha256,
          staleResolution: 'current',
        },
        config: { defaults },
      },
      project.revision,
      { ids, clock, runtime },
    );
    contents.set(promptRef.relativePath, promptText);
    await commit(next, new Map([[promptRef.relativePath, promptText]]));
    const task = project.tasks.at(-1);
    for (const status of ['preparing', 'requesting', 'processing']) {
      next = transitionTask(project, task.id, { status }, project.revision, clock.now(), runtime);
      await commit(next);
    }
    const versionId = versionIdSchema.parse(uuid(namespace, 800000 + number));
    const successTransactionId = uuid(namespace, 850000 + number);
    next = transitionTask(
      project,
      task.id,
      {
        status: 'saving',
        successTransactionId,
        proposedVersionId: versionId,
        targetRevision: project.revision + 2,
      },
      project.revision,
      clock.now(),
      runtime,
    );
    await commit(next);
    const savingTask = project.tasks.find((candidate) => candidate.id === task.id);
    const versionText = `合成活动规范开展\n\n2026年8月9日，合成学院在测试会场举办规范写作交流活动。第${number}版仅用于存储验收。\n\n合成学院\n2026年8月9日\n`;
    const versionRef = textRef(`content/versions/${versionId}.md`, versionText);
    contents.set(versionRef.relativePath, versionText);
    next = commitSuccessfulVersion(
      project,
      { taskId: task.id, contentRef: versionRef, createdAt: clock.now() },
      project.revision,
      { readText: (ref) => contents.get(ref.relativePath) },
      runtime,
    );
    await commit(
      next,
      new Map([[versionRef.relativePath, versionText]]),
      'completeTaskWithVersion',
      {
        operation: 'completeTaskWithVersion',
        successTransactionId,
        taskId: task.id,
        fromTaskSequence: savingTask.sequence,
        toTaskSequence: savingTask.sequence + 1,
        versionId,
        baseRevision: project.revision,
        revision: project.revision + 1,
      },
    );
    return { versionId, versionText };
  };

  return {
    ids,
    clock,
    session,
    get project() {
      return project;
    },
    commit,
    generate,
    contents,
  };
};

const generateLinear = async () => {
  const fixture = await createFixture('linear', 0x31000001, 4);
  await fixture.generate('draftGeneration', 1);
  await fixture.generate('aiReview', 2);
  const retrievalText = '规范 写作 交流';
  const retrieval = {
    id: fixture.ids.next('retrievalReport'),
    createdAt: fixture.clock.now(),
    knowledgeVersion: 'synthetic-v1',
    retrievalEngineVersion: 'fixture-v1',
    redactedQueryText: retrievalText,
    querySha256: sha256(Buffer.from(retrievalText, 'utf8')),
    factHints: { dates: [], times: [], locations: [], participants: [], missing: [] },
    hits: [],
  };
  let next = recordRetrieval(
    fixture.project,
    retrieval,
    fixture.project.revision,
    fixture.clock.now(),
    runtime,
  );
  await fixture.commit(next);
  next = recordExport(
    fixture.project,
    {
      id: fixture.ids.next('exportRecord'),
      versionId: fixture.project.latestVersionId,
      attemptedAt: fixture.clock.now(),
      completedAt: fixture.clock.now(),
      fileName: 'synthetic-final.docx',
      destinationDisplay: '测试目录',
      templateVersion: 'fixture-v1',
      appVersion: '0.1.0-fixture',
      status: 'succeeded',
      outputSha256: sha256(Buffer.from('synthetic-docx', 'utf8')),
      byteLength: 14,
    },
    fixture.project.revision,
    fixture.clock.now(),
    runtime,
  );
  await fixture.commit(next);
  await fixture.session.close();
};

const generateBranch = async () => {
  const fixture = await createFixture('branch', 0x32000001, 5);
  const first = await fixture.generate('draftGeneration', 1);
  const start = first.versionText.indexOf('规范写作');
  const firstRecord = fixture.project.versions.find((version) => version.id === first.versionId);
  let next = addComment(
    fixture.project,
    {
      versionId: first.versionId,
      anchor: {
        kind: 'textQuote',
        contentSha256: firstRecord.contentRef.sha256,
        start,
        end: start + 4,
        exact: '规范写作',
        prefix: '举办',
        suffix: '交流活动',
      },
      body: '改为新闻写作',
    },
    fixture.project.revision,
    {
      ids: fixture.ids,
      clock: fixture.clock,
      runtime,
      artifacts: { readText: (ref) => fixture.contents.get(ref.relativePath) },
    },
  );
  await fixture.commit(next);
  const commentId = fixture.project.comments[0].id;
  const second = await fixture.generate('commentRevision', 2);
  next = setLatestVersion(
    fixture.project,
    first.versionId,
    fixture.project.revision,
    fixture.clock.now(),
    runtime,
  );
  await fixture.commit(next);
  next = editComment(
    fixture.project,
    {
      commentId,
      anchor: fixture.project.comments[0].anchor,
      body: '改为规范新闻写作',
    },
    fixture.project.revision,
    fixture.clock.now(),
    { readText: (ref) => fixture.contents.get(ref.relativePath) },
    runtime,
  );
  await fixture.commit(next);
  const third = await fixture.generate('commentRevision', 3);
  if (second.versionId === third.versionId) throw new Error('branch fixture did not branch');
  await fixture.session.close();
};

await rm(fixtureRoot, { recursive: true, force: true });
await mkdir(fixtureRoot, { recursive: true });
await generateLinear();
await generateBranch();
await cp(path.join(fixtureRoot, 'linear'), path.join(fixtureRoot, 'corrupt'), {
  recursive: true,
});
await writeFile(
  path.join(fixtureRoot, 'corrupt', 'content', 'versions', `${uuid(0x31000001, 800002)}.md`),
  'tampered fixture content\n',
  'utf8',
);
