import { parentPort } from 'node:worker_threads';

import { workerCommandSchema, type WorkerEvent } from './contracts.js';
import { DeepSeekClient } from './deepseek.js';
import { asSafeError, makeSafeError } from './errors.js';

const port = parentPort;
if (port === null) throw new Error('AI worker requires a parent port');

let active: { taskId: string; controller: AbortController } | undefined;

const post = (event: WorkerEvent): void => port.postMessage(event);

port.on('message', (raw: unknown) => {
  const command = workerCommandSchema.safeParse(raw);
  if (!command.success) {
    if (active !== undefined) {
      post({
        type: 'failed',
        taskId: active.taskId as WorkerEvent['taskId'],
        error: makeSafeError('PROTOCOL_INVALID', 'The worker received an invalid command'),
      });
    } else {
      port.close();
    }
    return;
  }
  if (command.data.type === 'cancel') {
    if (active?.taskId === command.data.taskId) active.controller.abort();
    return;
  }
  if (active !== undefined) {
    post({
      type: 'failed',
      taskId: command.data.taskId,
      error: makeSafeError('PROTOCOL_INVALID', 'The worker already has an active task'),
    });
    return;
  }
  const controller = new AbortController();
  active = { taskId: command.data.taskId, controller };
  post({ type: 'requesting', taskId: command.data.taskId });
  const client = new DeepSeekClient({
    onHeaders: () => post({ type: 'processing', taskId: command.data.taskId }),
  });
  void client
    .complete(command.data.input, command.data.apiKey, controller.signal)
    .then((result) => post({ type: 'completed', taskId: command.data.taskId, result }))
    .catch((error: unknown) =>
      post({ type: 'failed', taskId: command.data.taskId, error: asSafeError(error) }),
    )
    .finally(() => {
      active = undefined;
    });
});
