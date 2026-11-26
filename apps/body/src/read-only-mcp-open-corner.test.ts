import * as sessionTools from './session-tool-connection.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildBwrapArgv, sandboxMountPlan } from './bwrap-sandbox.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { approveMerge, closeCorner, openCorner } from './read-only-mcp-open-corner.js';
import { listSchedules } from './read-only-mcp-download-attachment.js';
import { callAgentTool } from './read-only-mcp-open-poll.js';
import { testTmpDir } from '../../../packages/test-helpers/helpers/helper.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('acknowledges creation without asserting that an unstartable worker is starting', async () => {
  const root = await mkdtemp(`${testTmpDir()}/beeline-thread-receipt-`); roots.push(root);
  await writeFile(join(root, 'draft.txt'), 'draft');
  execFileSync('/usr/bin/git', ['init', '-b', 'main', root]);
  const wrapped = buildBwrapArgv({ bwrapPath: '/usr/bin/bwrap',
    plan: sandboxMountPlan({ mode: 'readonly', cwd: root }), cwd: root,
    command: '/usr/bin/git', args: ['add', 'draft.txt'] });
  const commit = spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8' });
  expect(commit.status).toBe(128);
  expect(commit.stderr).toContain('index.lock');
  expect(commit.stderr).toContain('Read-only file system');
  vi.spyOn(sessionTools, 'sessionCommandContext').mockResolvedValue({ roomId: 'parent', requestId: 'request' });
  for (const [key, value] of Object.entries({ BEELINE_DAEMON_ROOM_ID: 'parent',
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

it('opens a fix thread from triage using the parent chat when room is omitted', async () => {
  vi.spyOn(sessionTools, 'sessionCommandContext').mockResolvedValue({roomId:'triage',requestId:'triage-order',itemId:'c'.repeat(64)});
  for (const [key,value] of Object.entries({BEELINE_DAEMON_ROOM_ID:'parent',
    BEELINE_DAEMON_CORNER_ID:'triage',BEELINE_DAEMON_BASE_URL:'http://daemon.test',BEELINE_DAEMON_TOKEN:'fixture'})) vi.stubEnv(key,value);
  const calls:Record<string,unknown>[]=[];
  vi.stubGlobal('fetch',async (url:URL,init:RequestInit) => {
    expect(new Headers(init.headers).get('x-beeline-command-id')).toBe('c'.repeat(64));
    calls.push(JSON.parse(String(init.body)));
    return Response.json(new URL(url).pathname.endsWith('getRoomRepositoryState') ? {resolution:'none'} : {cornerId:'fix'});
  });
  expect(JSON.parse(await openCorner({implementer:'worker',brief:{spec:'Fix the triaged issue'}},'fix-call')).address).toBe('fix');
  expect(calls.at(-1)).toMatchObject({roomId:'triage',requestId:'triage-order',targetRoomId:'parent'});
});

it('submits native review text and exact-head approval through the active session', async () => {
  vi.stubEnv('BEELINE_DAEMON_CORNER_ID', 'thread');
  vi.stubEnv('BEELINE_GRANT_RUNNER_URL', 'http://runner.test');
  const authority = { roomId: 'thread', requestId: 'review-request' };
  vi.spyOn(sessionTools, 'sessionCommandContext').mockResolvedValue({ ...authority, itemId: 'review-item' });
  const approved = { status: 'approved', messageId: 'review-post' };
  const send = vi.spyOn(sessionTools, 'sessionToolRequest').mockResolvedValue(approved);
  const headSha = 'f'.repeat(40);
  const text = 'PASS: verified the reproduction.';

  expect(JSON.parse(await approveMerge({ address: 'thread', headSha, text }))).toEqual(approved);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith('session', {
    placeId: 'thread', action: 'operation', operation: 'approveCornerMerge', commandId: 'review-item',
    input: { ...authority, cornerId: 'thread', headSha, text },
  });
});

it('forwards structured receipts and provenance from openCorner, closeCorner, wake, and listSchedules', async () => {
  vi.spyOn(sessionTools, 'sessionCommandContext').mockResolvedValue({ roomId: 'parent', requestId: 'req-1' });
  for (const [key, value] of Object.entries({
    BEELINE_DAEMON_ROOM_ID: 'parent',
    BEELINE_DAEMON_BASE_URL: 'http://daemon.test',
    BEELINE_DAEMON_TOKEN: 'fixture',
  })) vi.stubEnv(key, value);

  const scheduleReceipt = {
    scheduleId: 'sched-1',
    nextRunAt: Date.parse('2026-11-26T14:00:00Z'),
    repliesTo: { identityId: 'u1', handle: 'lunchboxfortwo', name: 'Lunchbox' },
    approvedBy: { identityId: 'u1', handle: 'lunchboxfortwo', sourceMessageId: 'msg-1' },
    receipt: 'Updated "Morning card" · next run Thu (9:00 a.m. ET) · replies to @lunchboxfortwo',
  };

  vi.stubGlobal('fetch', async (url: URL) => {
    const op = new URL(url).pathname.split('/').at(-1)!;
    if (op === 'getRoomRepositoryState') return Response.json({ resolution: 'none' });
    if (op === 'createCorner') {
      return Response.json({
        cornerId: 'corner-1',
        name: 'mcp-state-receipts',
        implementer: 'crayon',
        approvedBy: { identityId: 'u1', name: 'lunchboxfortwo', sourceMessageId: 'msg-1' },
        receipt: 'Opened thread "mcp-state-receipts" · implementer @crayon · approved by @lunchboxfortwo',
      });
    }
    if (op === 'archiveCorner') {
      return Response.json({
        ok: true,
        receipt: 'Closed thread "mcp-state-receipts"',
      });
    }
    if (op === 'updateAgentSchedule') return Response.json(scheduleReceipt);
    if (op === 'setEventSubscriptions') {
      return Response.json({
        kinds: ['check-failed'],
        receipt: 'Replaced chat event subscriptions · active: check-failed',
      });
    }
    if (op === 'setAgentWakePaused') {
      return Response.json({
        paused: true,
        repliesTo: scheduleReceipt.repliesTo,
        receipt: 'Paused "Morning card" · replies to @lunchboxfortwo',
      });
    }
    return Response.json({ ok: true });
  });

  const opened = JSON.parse(
    await openCorner({ name: 'mcp-state-receipts', implementer: 'crayon', brief: { spec: 'Add receipts' } }, 'call-open'),
  );
  expect(opened).toMatchObject({
    address: 'corner-1',
    status: 'created',
    implementer: 'crayon',
    approvedBy: { identityId: 'u1', name: 'lunchboxfortwo', sourceMessageId: 'msg-1' },
    receipt: 'Opened thread "mcp-state-receipts" · implementer @crayon · approved by @lunchboxfortwo',
  });

  const closed = JSON.parse(await closeCorner({ cornerId: 'corner-1' }));
  expect(closed).toEqual({
    cornerId: 'corner-1',
    status: 'closed',
    receipt: 'Closed thread "mcp-state-receipts"',
  });

  const updated = JSON.parse(
    await callAgentTool(
      'wake',
      {
        action: 'update',
        trigger: 'schedule',
        scheduleId: 'sched-1',
        title: 'Morning card',
        cadence: { kind: 'interval', everyMinutes: 60 },
      },
      'call-wake-update',
    ),
  );
  expect(updated).toEqual(scheduleReceipt);

  const paused = JSON.parse(
    await callAgentTool('wake', { action: 'pause', scheduleId: 'sched-1' }, 'call-wake-pause'),
  );
  expect(paused.receipt).toBe('Paused "Morning card" · replies to @lunchboxfortwo');

  const replaced = JSON.parse(
    await callAgentTool(
      'wake',
      { action: 'replace_events', kinds: ['check-failed'] },
      'call-wake-events',
    ),
  );
  expect(replaced.receipt).toBe('Replaced chat event subscriptions · active: check-failed');

  const listedText = await listSchedules({
    roomId: 'parent',
    execute: async () => ({
      schedules: [
        {
          scheduleId: 'sched-1',
          roomId: 'parent',
          roomName: '#beeline',
          title: 'Morning card',
          agentId: 'a1',
          cadence: { kind: 'interval', everyMinutes: 60 },
          prompt: 'Post morning card',
          nextRunAt: Math.floor(Date.parse('2026-11-26T14:00:00Z') / 1000),
          repliesTo: { identityId: 'u1', handle: 'lunchboxfortwo' },
          approvedBy: { identityId: 'u1', handle: 'lunchboxfortwo', sourceMessageId: 'msg-1' },
        },
      ],
    }),
  });
  expect(listedText).toContain('replies to @lunchboxfortwo');
  expect(listedText).toContain('approved by @lunchboxfortwo (msg-1)');
});
