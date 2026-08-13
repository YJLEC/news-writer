import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corepackCli = path.join(
  path.dirname(process.execPath),
  'node_modules',
  'corepack',
  'dist',
  'corepack.js',
);
const result = spawnSync(
  process.execPath,
  [corepackCli, 'pnpm', 'licenses', 'list', '--prod', '--json'],
  {
    cwd: repositoryRoot,
    encoding: 'utf8',
  },
);

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const report = JSON.parse(result.stdout);
const allowedLicenses = new Set(['Apache-2.0', 'BSD-2-Clause', 'ISC', 'MIT']);
const reviewedLicenses = new Map([
  ['(MPL-2.0 OR Apache-2.0)', { packageName: 'dompurify', selectedLicense: 'Apache-2.0' }],
  ['(MIT OR GPL-3.0-or-later)', { packageName: 'jszip', selectedLicense: 'MIT' }],
  ['(MIT AND Zlib)', { packageName: 'pako', selectedLicense: 'MIT AND Zlib' }],
  ['BlueOak-1.0.0', { packageName: 'sax', selectedLicense: 'BlueOak-1.0.0' }],
]);
const deniedLicensePattern = /(?:^|[^A-Z])(?:AGPL|GPL|SSPL)(?:[^A-Z]|$)/i;
const packages = [];
const policyErrors = [];

for (const [license, entries] of Object.entries(report)) {
  for (const entry of entries) {
    let effectiveLicense = license;
    if (!allowedLicenses.has(license)) {
      const reviewed = reviewedLicenses.get(license);
      if (reviewed?.packageName === entry.name) {
        effectiveLicense = reviewed.selectedLicense;
      } else if (deniedLicensePattern.test(license)) {
        policyErrors.push(
          `${entry.name}@${entry.versions.join(', ')} uses denied license ${license}`,
        );
        continue;
      } else {
        policyErrors.push(
          `${entry.name}@${entry.versions.join(', ')} requires license review for ${license}`,
        );
        continue;
      }
    }

    for (const version of entry.versions) {
      packages.push({
        effectiveLicense,
        license,
        name: entry.name,
        packagePath: entry.paths[0],
        version,
      });
    }
  }
}

if (policyErrors.length > 0) {
  for (const error of policyErrors) {
    console.error(error);
  }
  process.exit(1);
}

packages.sort((left, right) =>
  `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, 'en'),
);

const sections = [
  'NEWS WRITER THIRD-PARTY NOTICES',
  '',
  'This distribution includes the production dependencies listed below.',
  'DOMPurify is used under the Apache License 2.0 option offered by its dual license.',
];

for (const dependency of packages) {
  const candidates = fs
    .readdirSync(dependency.packagePath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(name));

  const licenseFiles =
    dependency.name === 'dompurify'
      ? candidates.filter((name) => name.toUpperCase() === 'LICENSE')
      : candidates;
  if (new Set(['hash.js', 'isarray']).has(dependency.name) && licenseFiles.length === 0) {
    licenseFiles.push('README.md');
  }
  const thirdPartyNoticePath = path.join(dependency.packagePath, 'ThirdPartyNotices.txt');
  if (fs.existsSync(thirdPartyNoticePath)) {
    licenseFiles.push('ThirdPartyNotices.txt');
  }

  if (licenseFiles.length === 0) {
    throw new Error(`No license text found for ${dependency.name}@${dependency.version}.`);
  }

  sections.push(
    '',
    '='.repeat(78),
    `${dependency.name}@${dependency.version}`,
    `Declared license: ${dependency.license}`,
    `Distributed under: ${dependency.effectiveLicense}`,
  );

  for (const licenseFile of [...new Set(licenseFiles)].sort()) {
    sections.push('', `--- ${licenseFile} ---`, '');
    sections.push(fs.readFileSync(path.join(dependency.packagePath, licenseFile), 'utf8').trim());
  }
}

const noticesPath = path.join(repositoryRoot, 'THIRD-PARTY-NOTICES.txt');
fs.writeFileSync(noticesPath, `${sections.join('\n')}\n`, 'utf8');
console.log(`License policy passed for ${packages.length} production dependencies.`);
console.log(`Generated ${noticesPath}.`);
