#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateBrassCss, generateStoneCss } from '../design-tokens/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TARGET = resolve(ROOT, 'apps/site/stone.css');
const SERVER_JOIN_HTML = resolve(ROOT, 'apps/server/assets/mcp/join.html');
const BRASS_BLOCK_PATTERN = /\/\* brass-tokens:start \*\/[\s\S]*?\/\* brass-tokens:end \*\//;

function renderIndentedBrassBlock(css = generateBrassCss()) {
  const indented = css
    .trimEnd()
    .split('\n')
    .map((line) => (line ? `      ${line}` : ''))
    .join('\n');
  return `/* brass-tokens:start */\n${indented}\n      /* brass-tokens:end */`;
}

export function syncStoneCss({ check = false, target = TARGET, serverJoinHtml = SERVER_JOIN_HTML } = {}) {
  const expectedStone = generateStoneCss();
  const expectedBrassBlock = renderIndentedBrassBlock(generateBrassCss());
  if (check) {
    let actual = '';
    try {
      actual = readFileSync(target, 'utf8');
    } catch {
      throw new Error(`Missing generated Stone CSS at ${target}. Run: npm run tokens:css`);
    }
    if (actual !== expectedStone) {
      throw new Error(`apps/site/stone.css is out of date with @beeline/design-tokens. Run: npm run tokens:css`);
    }
    if (serverJoinHtml) {
      let joinHtml = '';
      try {
        joinHtml = readFileSync(serverJoinHtml, 'utf8');
      } catch {
        throw new Error(`Missing server MCP join template at ${serverJoinHtml}.`);
      }
      const match = joinHtml.match(BRASS_BLOCK_PATTERN);
      if (!match) {
        throw new Error(`apps/server/assets/mcp/join.html is missing /* brass-tokens:start */ markers. Run: npm run tokens:css`);
      }
      if (match[0] !== expectedBrassBlock) {
        throw new Error(`apps/server/assets/mcp/join.html Brass tokens are out of date with @beeline/design-tokens. Run: npm run tokens:css`);
      }
    }
    return { status: 'ok', target, serverJoinHtml };
  }
  writeFileSync(target, expectedStone);
  if (serverJoinHtml) {
    const joinHtml = readFileSync(serverJoinHtml, 'utf8');
    if (!BRASS_BLOCK_PATTERN.test(joinHtml)) {
      throw new Error(`${serverJoinHtml} is missing /* brass-tokens:start */ markers.`);
    }
    writeFileSync(serverJoinHtml, joinHtml.replace(BRASS_BLOCK_PATTERN, expectedBrassBlock));
  }
  return { status: 'written', target, serverJoinHtml };
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
