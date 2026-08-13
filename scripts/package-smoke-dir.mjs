import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const builderCli = require.resolve('electron-builder/cli.js');
const childEnvironment = { ...process.env };
delete childEnvironment.COREPACK_ROOT;

const child = spawn(
  process.execPath,
  [builderCli, '--config', 'electron-builder.package-smoke.yml', '--dir', '--win', '--x64'],
  { env: childEnvironment, stdio: 'inherit' },
);

child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`electron-builder was terminated by ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
