import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { callAgentTool } from './read-only-mcp-open-poll.js';
import { agentToolsFor } from './minimal-tool-surface.js';
import { validateAdvertisedToolInput } from './read-only-mcp-open-poll.js';
describe('typed Work board tools', () => {
  const tools = agentToolsFor(true, false, true, true);
  const ask = tools.find((tool) => tool.name === 'ask_owner')!;
  it('advertises typed about references, short options and free-text questions', () => {
    expect(ask).toBeDefined();
    expect(tools.some((tool) => tool.name === 'update_work')).toBe(true);
    expect(() =>
      validateAdvertisedToolInput(ask, {
        about: { kind: 'thread', roomId: 'thread' },
        question: 'Which surface next?',
        options: [{ label: 'Web', recommended: true }, { label: 'Phone' }],
      }),
    ).not.toThrow();
    expect(() =>
      validateAdvertisedToolInput(ask, {
        about: { kind: 'request', roomId: 'thread', messageId: 'ask' },
        question: 'Who should receive it?',
        freeText: true,
      }),
    ).not.toThrow();
  });
  it('gives the agent a shortening error before a tool call', () => {
    expect(() =>
      validateAdvertisedToolInput(ask, {
        about: { kind: 'thread', roomId: 'thread' },
        question: Array(21).fill('word').join(' '),
        freeText: true,
      }),
    ).toThrow('Shorten question');
    expect(() =>
      validateAdvertisedToolInput(ask, {
        about: { kind: 'thread', roomId: 'thread' },
        question: 'Which surface?',
        options: [{ label: 'One two three four' }, { label: 'Phone' }],
      }),
    ).toThrow('Shorten options');
  });
  it('dispatches named create, state and assignment tools through the same authorized work write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'beeline-work-tools-'));
    const context = join(directory, 'turn.json');
    await writeFile(context, JSON.stringify({ roomId: 'source-chat', requestId: 'command' }));
    const fetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ messageId: '', createdAt: 1 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', context);
    vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'https://daemon.example');
    vi.stubEnv('BEELINE_DAEMON_TOKEN', 'test-token');
    const written = () =>
      JSON.parse((fetch.mock.calls.at(-1) as unknown as [URL, { body: string }])[1].body);
    try {
      const created = JSON.parse(
        await callAgentTool(
          'create_work_item',
          { roomId: 'target-chat', title: 'Measure phone reply latency' },
          'create-1',
        ),
      );
      expect(created.id).toMatch(/^[a-f0-9]{64}$/);
      expect(written()).toMatchObject({
        roomId: 'source-chat',
        requestId: 'command',
        targetRoomId: 'target-chat',
        id: created.id,
        state: 'backlog',
        title: 'Measure phone reply latency',
      });
      await callAgentTool(
        'create_work_item',
        { roomId: 'target-chat', title: 'Measure phone reply latency' },
        'create-1',
      );
      expect(written().id).toBe(created.id);
      await callAgentTool(
        'create_work_item',
        { roomId: 'target-chat', title: 'Wire Milo replies', objective: 'Milo answers inline.', state: 'in-progress' },
        'create-2',
      );
      expect(written().state).toBe('in-progress');
      expect(written().objective).toBe('Milo answers inline.');
      expect(written().id).not.toBe(created.id);
      const target = { roomId: 'target-chat', id: created.id };
      await callAgentTool('set_work_state', { ...target, state: 'backlog' }, 'move');
      expect(written()).toMatchObject({
        ...target,
        roomId: 'source-chat',
        targetRoomId: 'target-chat',
        state: 'backlog',
      });
      for (const assigneeId of ['agent', 'person', null]) {
        await callAgentTool('assign_work_item', { ...target, assigneeId }, 'assign');
        expect(written().assigneeId).toBe(assigneeId);
      }
      expect(fetch.mock.calls).toHaveLength(7);
      expect(
        fetch.mock.calls.every((call) =>
          String(call[0]).endsWith('/v1/daemon/operations/updateWorkItem'),
        ),
      ).toBe(true);
      await expect(
        callAgentTool('set_work_state', { ...target, state: 'unknown' }, 'invalid'),
      ).rejects.toThrow('invalid arguments');
      expect(fetch.mock.calls).toHaveLength(7);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await unlink(context);
      await rmdir(directory);
    }
  });
});
