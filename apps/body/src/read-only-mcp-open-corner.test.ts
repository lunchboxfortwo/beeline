import { execFileSync, spawnSync } from 'node:child_process';
import { buildBwrapArgv, sandboxMountPlan } from './bwrap-sandbox.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openCorner } from './read-only-mcp-open-corner.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('acknowledges creation without asserting that an unstartable worker is starting', async () => {
  const root = await mkdtemp('/var/tmp/beeline-thread-receipt-'); roots.push(root);
  await writeFile(join(root, 'draft.txt'), 'draft');
  execFileSync('/usr/bin/git', ['init', '-b', 'main', root]);
  const wrapped = buildBwrapArgv({ bwrapPath: '/usr/bin/bwrap',
    plan: sandboxMountPlan({ mode: 'readonly', cwd: root }), cwd: root,
    command: '/usr/bin/git', args: ['add', 'draft.txt'] });
  const commit = spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8' });
  expect(commit.status).toBe(128);
  expect(commit.stderr).toContain('index.lock');
  expect(commit.stderr).toContain('Read-only file system');
  const context = join(root, 'turn.json');
  await writeFile(context, JSON.stringify({ roomId: 'parent', requestId: 'request' }));
  for (const [key, value] of Object.entries({ BEELINE_TURN_CONTEXT_FILE: context, BEELINE_DAEMON_ROOM_ID: 'parent',
    BEELINE_DAEMON_BASE_URL: 'http://daemon.test', BEELINE_DAEMON_TOKEN: 'fixture' })) vi.stubEnv(key, value);
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: URL) => {
    const name = new URL(url).pathname.split('/').at(-1)!;
    calls.push(name);
    // Creation proves no checkout or startup outcome. This same receipt is
    // returned on an idempotent replay after a worker has failed to commit.
    return Response.json(name === 'getRoomRepositoryState'
      ? { resolution: 'repository', key: 'owner/repo', remote: 'https://github.com/owner/repo.git' }
      : { cornerId: 'thread' });
  });
  for (let replay = 0; replay < 2; replay++) {
    const result = JSON.parse(await openCorner({ name: 'example', brief: { spec: 'Update documentation' } }, 'call'));
    expect(result).toMatchObject({ address: 'thread', status: 'created' });
    expect(result.status).not.toBe('starting');
  }
  expect(calls).toEqual(['getRoomRepositoryState', 'createCorner', 'getRoomRepositoryState', 'createCorner']);
});
