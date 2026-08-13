import { parentPort } from 'node:worker_threads';

let ignoreCancellation = false;

parentPort.on('message', (command) => {
  if (command.type === 'cancel') {
    if (ignoreCancellation) return;
    parentPort.postMessage({
      type: 'failed',
      taskId: command.taskId,
      error: {
        code: 'REQUEST_CANCELLED',
        occurredAt: '2026-08-09T01:00:00.000Z',
        safeMessage: 'The request was cancelled',
        retryable: true,
      },
    });
    return;
  }
  ignoreCancellation = command.input.messages[0]?.content === 'ignore-cancel';
  parentPort.postMessage({ type: 'requesting', taskId: command.taskId });
  if (command.input.messages[0]?.content === 'malformed') {
    parentPort.postMessage({ type: 'unknown', taskId: command.taskId });
    return;
  }
  if (command.input.messages[0]?.content === 'extra') {
    parentPort.postMessage({ type: 'processing', taskId: command.taskId, extra: true });
    return;
  }
  if (command.input.messages[0]?.content === 'wrong-task') {
    parentPort.postMessage({
      type: 'processing',
      taskId: '00000000-0000-4000-8000-000000000099',
    });
    return;
  }
  if (command.input.messages[0]?.content === 'forged') {
    parentPort.postMessage({ type: 'succeeded', taskId: command.taskId, content: 'forged' });
    return;
  }
  if (command.input.messages[0]?.content === 'crash') process.exit(7);
  if (command.input.messages[0]?.content === 'exit-zero') process.exit(0);
  if (command.input.messages[0]?.content === 'throw') throw new Error('worker fixture failure');
  if (command.input.messages[0]?.content === 'hang') return;
  if (command.input.messages[0]?.content === 'ignore-cancel') return;
  parentPort.postMessage({ type: 'processing', taskId: command.taskId });
  parentPort.postMessage({
    type: 'completed',
    taskId: command.taskId,
    result: {
      id: 'worker-completion',
      model: command.input.model,
      content: 'Worker result',
      finishReason: 'stop',
    },
  });
});
