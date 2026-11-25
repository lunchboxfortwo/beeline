#!/usr/bin/env node
// Install dependencies and compile shared workspace exports before corner work.
import { existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--extra') {
  if (args.length !== 2) throw new Error('Usage: npm run corner:prepare -- --extra <path>');
  const path = realpathSync(args[1]);
  const registry = resolve('.beeline-extra-dependencies');
  mkdirSync(registry, { recursive: true });
  writeFileSync(resolve(registry, createHash('sha256').update(path).digest('hex')), path);
  console.log('Extra-copy dependencies requested. Beeline prepares and seals them at the next turn. Keep temporary rigs inside this corner or its agent home.');
  process.exit(0);
}
const flags = new Set(args);
const allowed = new Set(['--mobile', '--build', '--help']);
for (const flag of flags) {
  if (!allowed.has(flag)) throw new Error(`Unknown preparation option: ${flag}`);
}
// Beeline passes the thread brief; the root install covers every other workspace.
if (/\bmobile\b/i.test(process.env.BEELINE_BRIEF ?? '')) flags.add('--mobile');
if (flags.has('--help')) {
  console.log('Usage: npm run corner:prepare -- [--mobile] [--build] | --extra <path>\nRoot dependencies and shared exports are prepared by default. Add --mobile for mobile work and --build for the full application build.');
} else {
  const run = (args, cwd) => {
    const result = spawnSync('npm', args, { stdio: 'inherit', cwd });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  };
  const managedRoot = existsSync('node_modules/.beeline-generation');
  const managedMobile = existsSync('apps/mobile/node_modules/.beeline-generation');
  if (!managedRoot && process.env.BEELINE_READONLY_DEPENDENCIES !== '1') run(['ci']);
  let mobileReady = false;
  if (flags.has('--mobile')) {
    if (flags.has('--build') && managedMobile && lstatSync('apps/mobile/node_modules').isSymbolicLink()) {
      // Native Gradle builds write under mobile dependency directories.
      unlinkSync('apps/mobile/node_modules');
      run(['run', 'mobile:install']);
      mobileReady = true;
    } else if (managedMobile || process.env.BEELINE_MOBILE_DEPENDENCIES_READY === '1') {
      const skia = './node_modules/.bin/setup-skia-web';
      if (existsSync(resolve('apps/mobile', skia))) {
        spawnSync(skia, ['public'], { stdio: 'inherit', cwd: 'apps/mobile' });
      }
      mobileReady = true;
    } else if (managedRoot || process.env.BEELINE_READONLY_DEPENDENCIES === '1') {
      writeFileSync('.beeline-dependency-request', 'mobile');
      console.log('Mobile dependencies requested. Call workspace to prepare them.');
    } else {
      run(['run', 'mobile:install']);
      mobileReady = true;
    }
  }
  run(['exec', '--', 'turbo', 'run', 'build', '--filter=@beeline/body^...', '--filter=@beeline/server^...']);
  if (flags.has('--build')) run(['run', 'build']);
  // Prepared means tests run: one test file in each prepared workspace.
  run(['exec', '--workspace=@beeline/body', '--', 'vitest', 'run', 'src/pi-retry-settings.test.ts']);
  if (mobileReady)
    run(['exec', '--', 'vitest', 'run', 'sources/buzz/agent-model-picker.test.ts'], 'apps/mobile');
}
