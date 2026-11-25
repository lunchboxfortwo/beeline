import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterAll, expect, it } from 'vitest';
import { isolatedNativeProof } from './lifecycle-test-guard.js';

const home = process.env.HOME!;
// The fixture setup hook runs after the suite's own cleanup hooks.
afterAll(() => {
  if (!isolatedNativeProof(process.env)) expect(existsSync(`${home}/child-output`)).toBe(true);
});

it.skipIf(isolatedNativeProof(process.env))('gives test children a private home through suite teardown', () => {
  const output = execFileSync(process.execPath, ['-e', `
    const { writeFileSync } = require('node:fs');
    writeFileSync(process.env.HOME + '/child-output', 'done');
    process.stdout.write(process.env.XDG_RUNTIME_DIR);
  `], { encoding: 'utf8' });
  expect(output).toBe(`${home}/run`);
  expect(home).toMatch(/\/beeline-test-[^/]+$/);
});
