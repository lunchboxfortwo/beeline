import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { reviewExactHead, reuseReviewDependencies } from './review-exact-head.mjs';

test('RUBY-15: exact-head bootstrap accepts workspace source entries and builds net before consumers', () => {
  const base = new URL('../.beeline-proof/', import.meta.url);
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base.pathname, 'review-bootstrap-'));
  const sha = 'a'.repeat(40);
  const mobile = JSON.parse(readFileSync(new URL('../apps/mobile/package-lock.json', import.meta.url)));
  assert(Object.keys(mobile.packages).some(path => path.startsWith('../../packages/')));
  const commands = [];
  try {
    mkdirSync(join(directory, 'apps/mobile'), { recursive: true });
    writeFileSync(join(directory, 'package-lock.json'), JSON.stringify({ packages: {} }));
    writeFileSync(join(directory, 'apps/mobile/package-lock.json'), JSON.stringify(mobile));
    const result = reviewExactHead([sha, '--typecheck', '@beeline/mobile'], {
      makeTemp: () => directory,
      git: args => ({ status: 0, stdout: args[0] === 'rev-parse' ? sha : '', stderr: '' }),
      reuse: () => false,
      run: (command, args) => { commands.push({ command, args }); return { status: 0 }; },
      log: () => {},
    });
    assert.equal(result.ok, true, JSON.stringify(result.failed));
    const build = commands.find(step => step.args[0] === 'run' && step.args[1] === 'build');
    assert(build.args.indexOf('@beeline/net') < build.args.indexOf('@beeline/body'));
    assert(build.args.includes('@beeline/net'));
    const sourceRoot = join(directory, 'source'), targetRoot = join(directory, 'target');
    const sourceMobile = join(sourceRoot, 'apps/mobile'), targetMobile = join(targetRoot, 'apps/mobile');
    const sourcePackage = join(sourceRoot, 'packages/api-contract'), targetPackage = join(targetRoot, 'packages/api-contract');
    const scope = join(sourceMobile, 'node_modules/@beeline');
    for (const path of [scope, sourcePackage, targetPackage, targetMobile]) mkdirSync(path, { recursive: true });
    const lock = JSON.stringify({ packages: { 'node_modules/@beeline/api-contract': { link: true, resolved: '../../packages/api-contract' } } });
    for (const path of [sourceMobile, targetMobile]) writeFileSync(join(path, 'package-lock.json'), lock);
    const key = createHash('sha256').update(`v2\0${process.platform}\0${process.arch}\0${process.versions.modules}\0`)
      .update(lock).digest('hex').slice(0, 32);
    writeFileSync(join(sourceMobile, 'node_modules/.beeline-generation'), JSON.stringify({ key }));
    symlinkSync(relative(scope, sourcePackage), join(scope, 'api-contract'));
    assert.equal(reuseReviewDependencies(sourceMobile, targetMobile, sourceRoot, targetRoot), true);
    assert.equal(realpathSync(join(targetMobile, 'node_modules/@beeline/api-contract')), targetPackage);
    // An actual dependency tree escaping the checkout remains unsafe.
    writeFileSync(join(directory, 'package-lock.json'), JSON.stringify({ packages: { '../node_modules/escape': {} } }));
    const unsafe = reviewExactHead([sha], {
      makeTemp: () => directory, reuse: () => false,
      git: () => ({ status: 0, stdout: sha, stderr: '' }),
      run: () => { throw new Error('must reject before npm'); }, log: () => {},
    });
    assert.equal(unsafe.ok, false);
    assert.match(unsafe.failed.detail, /Unsafe dependency lockfile/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
