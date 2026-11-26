#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateStoneCss } from '../design-tokens/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TARGET = resolve(ROOT, 'apps/site/stone.css');

export function syncStoneCss({ check = false, target = TARGET } = {}) {
  const expected = generateStoneCss();
  if (check) {
    let actual = '';
    try {
      actual = readFileSync(target, 'utf8');
    } catch {
      throw new Error(`Missing generated Stone CSS at ${target}. Run: npm run tokens:css`);
    }
    if (actual !== expected) {
      throw new Error(`apps/site/stone.css is out of date with @beeline/design-tokens. Run: npm run tokens:css`);
    }
    return { status: 'ok', target };
  }
  writeFileSync(target, expected);
  return { status: 'written', target };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const check = process.argv.includes('--check');
  try {
    const result = syncStoneCss({ check });
    console.log(check ? 'Stone CSS matches @beeline/design-tokens' : `Wrote ${result.target}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
