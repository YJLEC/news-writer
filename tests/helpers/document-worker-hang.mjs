import { parentPort } from 'node:worker_threads';
parentPort.once('message', () => void 0);
setInterval(() => void 0, 1_000);
