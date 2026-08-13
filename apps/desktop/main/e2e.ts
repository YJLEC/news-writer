import { app } from 'electron';

import { startDesktop } from './bootstrap.js';
import { ControlledMockWorkerRunner, parseControlledPlan } from './e2e-controlled-runner.js';

const sentinel = 'news-writer-controlled-ai-e2e-v1';
if (app.isPackaged || process.env.NW_CONTROLLED_AI_E2E !== sentinel) {
  throw new Error('Controlled AI is available only from the unpackaged E2E entry.');
}

startDesktop(
  new ControlledMockWorkerRunner(parseControlledPlan(process.env.NW_CONTROLLED_AI_PLAN)),
);
