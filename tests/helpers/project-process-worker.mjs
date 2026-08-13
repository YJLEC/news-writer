import process from 'node:process';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';

import { commitSuccessfulVersion, updateProjectConfig } from '../../packages/domain/dist/index.js';
import { projectRelativePathSchema } from '../../packages/shared/dist/index.js';
import {
  makeCommitId,
  makeTransactionId,
  nowForProject,
  openProject,
  sha256,
} from '../../packages/project/dist/index.js';
import { setCommitBarrierForTest } from '../../packages/project/dist/faults.js';

const [mode, root, barrier, markerPath] = process.argv.slice(2);

const runtime = {
  appVersion: 'process-test',
  electronVersion: process.versions.electron ?? '43.3.0',
  chromiumVersion: process.versions.chrome ?? '150.0.0',
};

const send = (message) => {
  if (typeof process.send === 'function') process.send(message);
};

const installCrashBarrier = () => {
  if (barrier === undefined) throw new Error('Crash barrier is required');
  setCommitBarrierForTest((currentBarrier) => {
    if (currentBarrier === barrier) {
      if (markerPath === undefined) throw new Error('Crash marker path is required');
      writeFileSync(markerPath, `${currentBarrier}\n`, { encoding: 'utf8', flag: 'wx' });
      const marker = openSync(markerPath, 'r');
      fsyncSync(marker);
      closeSync(marker);
      process.kill(process.pid, 'SIGKILL');
    }
  });
};

try {
  if (root === undefined) throw new Error('Project root is required');
  const session = await openProject({ root, appVersion: 'process-test' });
  if (mode === 'hold-lock') {
    send({ status: 'locked' });
    setInterval(() => undefined, 1_000);
  } else if (mode === 'try-open') {
    send({ status: 'opened' });
    await session.close();
    process.exit(0);
  } else if (mode === 'crash') {
    const current = session.read();
    const next = updateProjectConfig(
      current,
      { model: `child-${barrier}` },
      current.revision,
      nowForProject(),
      runtime,
    );
    installCrashBarrier();
    await session.commit({
      transactionId: makeTransactionId(),
      commitId: makeCommitId(),
      expectedRevision: current.revision,
      expectedHeadCommitId: session.headCommitId,
      nextAggregate: next,
    });
    process.exit(0);
  } else if (mode === 'crash-complete') {
    const current = session.read();
    const task = current.tasks.find((candidate) => candidate.status === 'saving');
    if (task === undefined) throw new Error('A saving task is required');
    const versionText = '合成新闻稿正文，仅用于完成事务强杀测试。\n';
    const versionBytes = Buffer.from(versionText, 'utf8');
    const contentRef = {
      relativePath: projectRelativePathSchema.parse(
        `content/versions/${task.proposedVersionId}.md`,
      ),
      sha256: sha256(versionBytes),
      byteLength: versionBytes.byteLength,
      mediaType: 'text/markdown',
      encoding: 'utf-8',
    };
    const completedAt = nowForProject();
    const next = commitSuccessfulVersion(
      current,
      { taskId: task.id, contentRef, createdAt: completedAt },
      current.revision,
      { readText: () => versionText },
      runtime,
    );
    installCrashBarrier();
    await session.commit({
      transactionId: task.successTransactionId,
      commitId: makeCommitId(),
      expectedRevision: current.revision,
      expectedHeadCommitId: session.headCommitId,
      operation: 'completeTaskWithVersion',
      details: {
        operation: 'completeTaskWithVersion',
        successTransactionId: task.successTransactionId,
        taskId: task.id,
        fromTaskSequence: task.sequence,
        toTaskSequence: task.sequence + 1,
        versionId: task.proposedVersionId,
        baseRevision: current.revision,
        revision: current.revision + 1,
      },
      nextAggregate: next,
      artifacts: new Map([[contentRef.relativePath, versionText]]),
    });
    process.exit(0);
  } else {
    throw new Error('Unknown worker mode');
  }
} catch (error) {
  send({
    status: 'error',
    code: typeof error === 'object' && error !== null && 'code' in error ? error.code : 'UNKNOWN',
  });
  process.exit(2);
}
