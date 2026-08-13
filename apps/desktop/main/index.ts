import { NodeWorkerRunner } from '@news-writer/ai';

import { startDesktop } from './bootstrap.js';

startDesktop(new NodeWorkerRunner(new URL('./ai-worker.js', import.meta.url)));
