import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { prepareRoomAgentCredentials } from './agent-home.js';

const roots: string[] = [];
const links: string[] = [];
afterEach(async () => {
  await Promise.all(links.splice(0).map(path => rm(path, { force: true })));
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it('squire-attach-1120: retires stale direct mounts before a cold harness starts, without optional prepare', async () => {
  const root = await mkdtemp(join(tmpdir(), 'squire-attach-')); roots.push(root);
  const home = join(root, 'private');
  const operatorHome = join(root, 'operator');
  await mkdir(operatorHome);
  const stale = { squire: { command: 'obsolete-squire-facade', args: [] } };
  for (const dir of ['codex', 'grok', 'claude', 'pi']) await mkdir(join(home, dir), { recursive: true });
  for (const dir of ['codex', 'grok']) await writeFile(join(home, dir, 'config.toml'),
    '[mcp_servers.squire]\ncommand = "obsolete-squire-facade"\n');
  await writeFile(join(home, 'claude', '.claude.json'), JSON.stringify({ mcpServers: stale }));
  await writeFile(join(home, 'pi', 'mcp.json'), JSON.stringify({ mcpServers: stale }));

  // PlaceSession calls only this mandatory home step before starting ACP.
  const env = await prepareRoomAgentCredentials({ root: home, operatorHome, agentKind: 'codex' });
  links.push(env.TMPDIR!);
  for (const dir of ['codex', 'grok']) {
    const config = parse(await readFile(join(home, dir, 'config.toml'), 'utf8'));
    expect(config.mcp_servers).toBeUndefined();
  }
  for (const file of ['claude/.claude.json', 'pi/mcp.json'])
    expect(JSON.parse(await readFile(join(home, file), 'utf8')).mcpServers).toEqual({});
  expect(await readFile(join(home, 'codex', 'config.toml'), 'utf8')).toContain('web_search');
});
