import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { callAgentTool } from './read-only-mcp-open-poll.js';
import { agentToolsFor } from './minimal-tool-surface.js';
import { validateAdvertisedToolInput } from './read-only-mcp-open-poll.js';
describe('typed Work board tools', () => {
  const tools = agentToolsFor(true, false, true, true);
  const reply = tools.find(tool=>tool.name==='reply')!;
  it('advertises short asks on replies and one work update surface',()=>{
    expect(()=>validateAdvertisedToolInput(reply,{id:'task',text:'Choose output',ask:{question:'Which output?',options:['Web','Phone'],recommended:'Web'}})).not.toThrow();
    for (const name of ['ask_owner','set_work_state','assign_work_item','add_work_note','attach_to_work_item']) expect(tools.some(tool=>tool.name===name)).toBe(false);
  });
  it('returns a plain shortening error before sending an oversized ask',()=>{
    expect(()=>validateAdvertisedToolInput(reply,{id:'task',text:'Choose output',ask:{question:Array(21).fill('word').join(' '),options:['Web','Phone']}})).toThrow('Shorten question');
    expect(()=>validateAdvertisedToolInput(reply,{id:'task',text:'Choose output',ask:{question:'Which output?',options:['One two three four','Phone']}})).toThrow('Shorten options');
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
      await callAgentTool('update_work', { ...target, state: 'backlog' }, 'move');
      expect(written()).toMatchObject({
        ...target,
        roomId: 'source-chat',
        targetRoomId: 'target-chat',
        state: 'backlog',
      });
      for (const assigneeId of ['agent', 'person', null]) {
        await callAgentTool('update_work', { ...target, assigneeId }, 'assign');
        expect(written().assigneeId).toBe(assigneeId);
      }
      expect(fetch.mock.calls).toHaveLength(7);
      expect(
        fetch.mock.calls.every((call) =>
          String(call[0]).endsWith('/v1/daemon/operations/updateWorkItem'),
        ),
      ).toBe(true);
      await expect(
        callAgentTool('update_work', { ...target, state: 'unknown' }, 'invalid'),
      ).rejects.toThrow('invalid arguments');
      expect(fetch.mock.calls).toHaveLength(7);
      await callAgentTool('update_work', { ...target, note: 'Hold until approved.' }, 'note');
      expect(String(fetch.mock.calls.at(-1)![0])).toMatch(/updateWorkItem$/);
      expect(written()).toMatchObject({ roomId: 'source-chat', targetRoomId: 'target-chat', id: created.id, note: 'Hold until approved.' });
      await callAgentTool('update_work', { ...target, attachments: [ { kind: 'link', name: 'Plan', url: 'https://example.org' }] }, 'link');
      expect(String(fetch.mock.calls.at(-1)![0])).toMatch(/updateWorkItem$/);
      expect(written().attachments[0]).toEqual({ kind: 'link', name: 'Plan', url: 'https://example.org' });
      await callAgentTool('update_work', { ...target, attachments: [ { kind: 'file', name: 'plan.pdf', objectId: 'stored-object' }] }, 'file');
      expect(written().attachments[0].objectId).toBe('stored-object');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await unlink(context);
      await rmdir(directory);
    }
  });
});
