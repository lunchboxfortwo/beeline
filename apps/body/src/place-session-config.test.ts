import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { PlaceSession } from './place-session.js';
import type { AgentRuntimeRecord } from './runtime.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('publishes complete tool context and resource-auth JSON while readers overlap rewrites', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-config-'));
  roots.push(root);
  // Exceed Node's write chunk size to exercise reads between chunks as well as truncation.
  const padding = 'x'.repeat(1024 * 1024);
  let generation = 0;
  const session = new PlaceSession({
    agent: { publicKey: 'a'.repeat(64), name: 'Agent' },
    runtime: { supervisorRoot: root } as AgentRuntimeRecord,
    config: { workspaceRoot: root, operatorHome: root } as BodyConfig,
    api: { connection: () => ({ baseUrl: 'https://synthetic.test', daemonToken: `${generation}:${padding}` }) } as unknown as DaemonApiClient,
    placeId: 'room', workspaceId: 'workspace', onExit() {},
  });
  const item = () => ({ id: `item-${generation}`, roomId: 'room', turnRequestId: `request-${generation}`,
    rootCommandId: 'task', reason: 'human_tag' }) as AgentCommand;
  const paths = [session.contextPath, `${session.contextPath}.resource-auth.json`];
  const observations = paths.map(() => new Set<string>());
  await session.writeContext(item(), [], padding);
  let writing = true;
  const readers = paths.map(async (path, index) => {
    while (writing) {
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (index === 0) {
        expect(value.ownedModelDirectory).toBe(padding);
        expect(value.requestId).toMatch(/^request-\d+$/);
        observations[index].add(value.requestId);
      } else {
        expect(value.turnContextPath).toBe(session.contextPath);
        expect(value.daemonToken.split(':')[1]).toBe(padding);
        observations[index].add(value.daemonToken.split(':')[0]);
      }
    }
  });
  // Attach immediately so a reader failure is reported after all writes settle.
  const reading = Promise.allSettled(readers);
  try {
    for (generation = 1; generation <= 12; generation++) await session.writeContext(item(), [], padding);
  } finally {
    writing = false;
  }
  for (const result of await reading) {
    if (result.status === 'rejected') throw result.reason;
  }
  for (const seen of observations) expect(seen.size).toBeGreaterThan(1);
  for (const path of paths) expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await readdir(root)).sort()).toEqual(['turn-context.json', 'turn-context.json.resource-auth.json']);
  await session.writeContext(undefined, []);
  expect(JSON.parse(await readFile(session.contextPath, 'utf8'))).toEqual({});
});
