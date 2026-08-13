import { createRequire } from 'node:module';
import { lstat, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const builderCli = require.resolve('electron-builder/cli.js');

const loadInstitutionBundleFromResourcesPathV1 = async (profile) => {
  const modulePath = path.join(repositoryRoot, 'packages', 'institution', 'dist', 'index.js');
  const module = await import(pathToFileURL(modulePath).href);
  return module.loadInstitutionBundleFromResourcesPathV1(profile);
};

const isInside = (candidate, parent) => {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const assertExternal = (value, label) => {
  const resolved = path.resolve(value);
  if (isInside(resolved, repositoryRoot))
    throw new Error(`${label} must be outside the repository.`);
  return resolved;
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.error('Usage: node scripts/package-private-profile.mjs --profile <dir> --output <dir>');
    process.exit(0);
  }
  const profileIndex = args.indexOf('--profile');
  const outputIndex = args.indexOf('--output');
  if (profileIndex < 0 || outputIndex < 0 || args.length !== 4)
    throw new Error('Invalid arguments.');
  const profile = args[profileIndex + 1];
  const output = args[outputIndex + 1];
  if (!profile || !output) throw new Error('Both --profile and --output require a path.');
  return {
    profile: assertExternal(profile, 'Profile directory'),
    output: assertExternal(output, 'Output directory'),
  };
};

const listProfileFiles = async (root) => {
  const files = [];
  const walk = async (directory, prefix = '') => {
    for (const name of await readdir(directory)) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const absolute = path.join(directory, name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Profile contains a symbolic link: ${relative}`);
      if (info.isDirectory()) await walk(absolute, relative);
      else if (info.isFile()) files.push(relative.replaceAll('\\', '/'));
      else throw new Error(`Profile contains an unsupported entry: ${relative}`);
    }
  };
  await walk(root);
  return files.sort();
};

const runBuilder = (configPath) =>
  new Promise((resolve, reject) => {
    const environment = { ...process.env };
    delete environment.COREPACK_ROOT;
    const child = spawn(
      process.execPath,
      [builderCli, '--config', configPath, '--dir', '--win', '--x64'],
      {
        cwd: repositoryRoot,
        env: environment,
        stdio: 'inherit',
      },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`electron-builder was terminated by ${signal}.`));
      else if (code !== 0) reject(new Error(`electron-builder exited with code ${code ?? 1}.`));
      else resolve();
    });
  });

const main = async () => {
  const { profile, output } = parseArgs();
  const profileInfo = await lstat(profile);
  if (!profileInfo.isDirectory() || profileInfo.isSymbolicLink())
    throw new Error('Profile must be a regular directory.');
  const realProfile = await realpath(profile);
  assertExternal(realProfile, 'Profile directory');
  const outputParent = path.dirname(output);
  const realOutputParent = await realpath(outputParent).catch(() => outputParent);
  assertExternal(realOutputParent, 'Output parent directory');
  if (isInside(output, profile) || isInside(profile, output))
    throw new Error('Profile and output directories must be separate.');
  if (await lstat(output).catch(() => undefined))
    throw new Error('Output directory already exists.');
  const files = await listProfileFiles(realProfile);
  const required = [
    'manifest.json',
    'institution.json',
    'rules/writing-rules.json',
    'rules/prompt-contract.json',
    'rules/document-style.json',
    'knowledge/corpus.jsonl',
    'knowledge/index.json',
    'knowledge/training_rules.txt',
    'knowledge/metadata.json',
    'fonts/manifest.json',
  ];
  if (required.some((file) => !files.includes(file)))
    throw new Error('Profile is missing a required resource.');
  const fontManifest = JSON.parse(
    await readFile(path.join(realProfile, 'fonts', 'manifest.json'), 'utf8'),
  );
  const allowed = new Set([
    ...required,
    ...fontManifest.fonts.map((font) => `fonts/${font.fileName}`),
  ]);
  if (files.some((file) => !allowed.has(file)))
    throw new Error('Profile contains files outside the fixed resource allowlist.');
  if (files.length !== allowed.size)
    throw new Error('Profile resource allowlist and files do not match.');
  await loadInstitutionBundleFromResourcesPathV1(realProfile);
  const configTemplate = await readFile(path.join(repositoryRoot, 'electron-builder.yml'), 'utf8');
  const profilePath = realProfile.replaceAll('\\', '/');
  const outputPath = output.replaceAll('\\', '/');
  const filter = files.map((file) => `      - ${file}`).join('\n');
  const replacement = [
    'extraResources:',
    '  - from: THIRD-PARTY-NOTICES.txt',
    '    to: THIRD-PARTY-NOTICES.txt',
    '  - from: ' + JSON.stringify(profilePath),
    '    to: institution',
    '    filter:',
    filter,
  ].join('\n');
  let config = configTemplate.replace(/extraResources:[\s\S]*?^files:/m, `${replacement}\nfiles:`);
  if (config === configTemplate)
    throw new Error('Could not create private electron-builder configuration.');
  config = config.replace(
    /^directories:\r?\n  output:.*$/m,
    `directories:\n  output: ${JSON.stringify(outputPath)}`,
  );
  const tempConfig = path.join(
    os.tmpdir(),
    `news-writer-private-builder-${process.pid}-${Date.now()}.yml`,
  );
  await writeFile(tempConfig, `${config}\n`, 'utf8');
  try {
    await runBuilder(tempConfig);
  } finally {
    await rm(tempConfig, { force: true });
  }
  const packagedProfile = path.join(output, 'resources', 'institution');
  const packagedFiles = await listProfileFiles(packagedProfile);
  if (
    packagedFiles.length !== files.length ||
    packagedFiles.some((file, index) => file !== files[index])
  ) {
    await rm(output, { recursive: true, force: true });
    throw new Error('Packaged institution resources do not match the approved allowlist.');
  }
  try {
    await loadInstitutionBundleFromResourcesPathV1(packagedProfile);
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  console.log(`Private portable app written to ${output}`);
};

main().catch((error) => {
  console.error(
    `Private packaging failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
