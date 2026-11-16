#!/usr/bin/env node

import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { recoveryCliBundleArgs } from './recovery-cli-bundle.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(root, 'packages/usebeeline/dist/usebeeline.mjs');

await rm(dirname(output), { recursive: true, force: true });
await mkdir(dirname(output), { recursive: true });
const result = spawnSync(
  'npx',
  [
    ...recoveryCliBundleArgs(resolve(root, 'apps/body/dist/recovery-cli.js'), output),
    '--define:import.meta.url="usebeeline:npm"',
  ],
  { cwd: root, stdio: 'inherit' },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await chmod(output, 0o755);
// The session-join adapters are ported from Reason Network; its notice ships with the bundle.
await copyFile(resolve(root, 'apps/body/src/session-join/NOTICE'), resolve(dirname(output), 'NOTICE-reason-network'));
// npm shows the GitHub README; its repo-relative logos load from the public downloads host.
const readme = await readFile(resolve(root, 'README.md'), 'utf8');
await writeFile(
  resolve(root, 'packages/usebeeline/README.md'),
  readme.replaceAll('apps/mobile/sources/assets/images/', 'https://downloads.usebeeline.app/brand/'),
);
