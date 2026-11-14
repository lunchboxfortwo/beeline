import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'yaml';
import { prepareRoomAgentHome } from './agent-home.js';

const roots: string[] = [];
const links: string[] = [];
afterEach(async () => {
  for (const path of links.splice(0)) await rm(path, { force: true });
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

it.each(['codex', 'pi', 'goose'] as const)('prepares a fresh %s home when the host has Goose configuration', async agentKind => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-goose-'));
  roots.push(root);
  const operatorHome = resolve(root, 'operator');
  const configDir = resolve(operatorHome, '.config', 'goose');
  await mkdir(configDir, { recursive: true });
  const config = 'GOOSE_PROVIDER: anthropic\nGOOSE_MODEL: fixture-model\nextensions: {}\n';
  const secrets = 'ANTHROPIC_API_KEY: fixture-key\n';
  await writeFile(resolve(configDir, 'config.yaml'), config);
  await writeFile(resolve(configDir, 'secrets.yaml'), secrets);

  const env = await prepareRoomAgentHome({ root: resolve(root, 'agent'), operatorHome, agentKind, failClosed: true });
  links.push(env.TMPDIR!);
  expect(env.HOME).toBe(resolve(root, 'agent', 'user'));
  const privateConfig = resolve(env.GOOSE_PATH_ROOT!, 'config', 'config.yaml');
  expect((await lstat(privateConfig)).isSymbolicLink()).toBe(false);
  expect(parse(await readFile(privateConfig, 'utf8'))).toMatchObject({ GOOSE_PROVIDER: 'anthropic', GOOSE_MODEL: 'fixture-model' });
  expect(await readFile(resolve(env.GOOSE_PATH_ROOT!, 'config', 'secrets.yaml'), 'utf8')).toBe(secrets);
  expect(await readFile(resolve(configDir, 'config.yaml'), 'utf8')).toBe(config);
});
