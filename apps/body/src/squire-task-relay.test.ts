import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { StdioSquireMcpClient } from './squire-mcp-client.js';
import { SquireTaskRelay } from './squire-task-relay.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

describe('Squire shared-session continuation', () => {
  it('resumes the shared signed-in session across turns while preserving explicit sessions and other sites', async () => {
    const sessions = new Map<string, boolean>();
    let nextId = 0;
    let shareFails = false;
    let stale = false;
    const authorized = vi.fn(async () => true);
    const requestMcp = vi.fn(async (_method: string, params: {
      name: string; arguments: { session_id?: string };
    }) => {
      const args = params.arguments;
      let id = args.session_id ?? '';
      if ((params.name === 'operate_share' && shareFails) || stale)
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({
          error: { code: stale ? 'stale_lease' : 'share_failed' },
        }) }] };
      if (params.name === 'operate_start' || (params.name === 'operate_drive' && !id)) {
        id = `browser-session-${++nextId}`;
        sessions.set(id, false);
      }
      if (params.name === 'operate_finish') sessions.delete(id);
      return { content: [{ type: 'text', text: JSON.stringify({
        session_id: id, signed_in: sessions.get(id),
        ...(params.name === 'operate_share' ? {
          url: `https://share.trycloudflare.com/s/${'s'.repeat(43)}/`,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        } : {}),
      }) }] };
    });
    const relay = new SquireTaskRelay('agent', 'room', '', authorized, '', () =>
      ({ requestMcp, close: vi.fn() }) as unknown as StdioSquireMcpClient);
    cleanups.push(() => relay.close());
    const activate = (requestId: string) => relay.activate({ agentId: 'agent', roomId: 'room',
      turnRequestId: requestId, rootCommandId: requestId } as AgentCommand, 'generation');
    activate('asking-turn');
    const { url, token } = await relay.listen();
    let requestId = 'asking-turn';
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(`${url}/mcp`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: 'room', requestId, taskId: requestId,
          generationId: 'generation', method: 'tools/call', params: { name, arguments: args } }),
      });
      expect(response.status).toBe(200);
      return JSON.parse((await response.json()).result.content[0].text);
    };
    const shared = await call('operate_start', { service_url: 'https://app.example/login' });
    const other = await call('operate_start', { service_url: 'https://other.example/' });
    await call('operate_share', { session_id: shared.session_id });
    // The person's sign-in changes only the browser being shown in the card.
    sessions.set(shared.session_id, true);
    relay.deactivate(requestId);
    requestId = 'handback-turn';
    activate(requestId);
    const facts = { email: 'person@example.test' };
    expect(await call('operate_drive', { url: 'https://app.example/dashboard',
      goal: 'Continue setup', facts })).toMatchObject({ session_id: shared.session_id, signed_in: true });
    expect(authorized).toHaveBeenLastCalledWith(expect.objectContaining({
      args: { session_id: shared.session_id, goal: 'Continue setup', facts },
    }));
    expect(requestMcp).toHaveBeenLastCalledWith('tools/call', {
      name: 'operate_drive', arguments: { session_id: shared.session_id, goal: 'Continue setup', facts },
    });
    expect(await call('operate_drive', { session_id: other.session_id, goal: 'Explicit session' }))
      .toMatchObject({ session_id: other.session_id, signed_in: false });
    expect(await call('operate_drive', { url: 'https://another.example/', goal: 'Different app' }))
      .toMatchObject({ signed_in: false });
    await call('operate_finish', { session_id: shared.session_id });
    expect(await call('operate_drive', { url: 'https://app.example/', goal: 'New setup' }))
      .toMatchObject({ signed_in: false });
    expect(nextId).toBe(4);
    // A failed share cannot displace the working card's continuation.
    await call('operate_share', { session_id: other.session_id });
    shareFails = true;
    await call('operate_share', { session_id: 'browser-session-4' });
    expect(await call('operate_drive', { url: 'https://other.example/', goal: 'Continue' }))
      .toMatchObject({ session_id: other.session_id });
    // Once Squire says the shared session is gone, a new drive can open it.
    stale = true;
    await call('operate_observe', { session_id: other.session_id });
    stale = false;
    expect(await call('operate_drive', { url: 'https://other.example/', goal: 'Restart' }))
      .toMatchObject({ session_id: 'browser-session-5', signed_in: false });
  });
});

describe('Squire approval pushes', () => {
  it.each(['approved', 'denied'] as const)(
    'forwards %s once after the asking turn ended, without another tool call', async (status) => {
      let notify!: (message: Record<string, unknown>) => void;
      const close = vi.fn();
      const decided = vi.fn();
      const requestMcp = vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify({
        status: 'approval_pending', approval_id: 'purchase-1',
        approval_url: 'https://trustysquire.ai/vault/pay/purchase-1',
      }) }] }));
      const relay = new SquireTaskRelay('agent', 'room', '', async () => true, '', callbacks => {
        notify = callbacks.onNotification;
        return { requestMcp, close } as unknown as StdioSquireMcpClient;
      }, decided);
      cleanups.push(() => relay.close());
      relay.activate({ agentId: 'agent', roomId: 'room', turnRequestId: 'asking-turn',
        rootCommandId: 'task' } as AgentCommand, 'generation');
      const { url, token } = await relay.listen();
      const response = await fetch(`${url}/mcp`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: 'room', requestId: 'asking-turn', taskId: 'task',
          generationId: 'generation', method: 'tools/call',
          params: { name: 'inject_card', arguments: { item: 'Flowers' } } }),
      });
      expect(response.status).toBe(200);
      await response.json();
      relay.deactivate('asking-turn');
      expect(close).not.toHaveBeenCalled();
      const decision = { method: 'notifications/approval_decided',
        params: { approval_id: 'purchase-1', status } };
      notify(decision);
      notify(decision);
      await vi.waitFor(() => expect(decided).toHaveBeenCalledOnce());
      expect(decided).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'asking-turn', approvalId: 'purchase-1', status, tool: 'inject_card',
      }));
      expect(requestMcp).toHaveBeenCalledOnce();
    },
  );

  it('retains a decision delivered in the same read as the pending result', async () => {
    const decided = vi.fn();
    const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const child = Object.assign(new EventEmitter(), {
      stdout, stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }), kill: vi.fn(),
      stdin: { write: (chunk: string) => {
        const frame = JSON.parse(chunk) as { id?: number; method: string };
        if (frame.id === undefined) return true;
        const result = frame.method === 'initialize' ? {} : {
          content: [{ type: 'text', text: JSON.stringify({
            status: 'approval_pending', approval_id: 'purchase-race',
            approval_url: 'https://trustysquire.ai/vault/pay/purchase-race',
          }) }],
        };
        const frames = [{ jsonrpc: '2.0', id: frame.id, result }];
        // A single stdio read resolves the result and delivers the decision
        // before the relay's await continuation can register the approval.
        stdout.emit('data', frames.map(frame => JSON.stringify(frame)).join('\n') + '\n' +
          (frame.method === 'tools/call' ? JSON.stringify({
            method: 'notifications/approval_decided',
            params: { approval_id: 'purchase-race', status: 'approved' },
          }) + '\n' : ''));
        return true;
      } },
    });
    const relay = new SquireTaskRelay('agent', 'room', '', async () => true, '', callbacks => {
      return new StdioSquireMcpClient({ scope: { agentId: 'agent', roomId: 'room' },
        env: {}, spawn: (() => child) as never, onNotification: callbacks.onNotification });
    }, decided);
    cleanups.push(() => relay.close());
    relay.activate({ agentId: 'agent', roomId: 'room', turnRequestId: 'asking-turn',
      rootCommandId: 'task' } as AgentCommand, 'generation');
    const { url, token } = await relay.listen();
    const response = await fetch(`${url}/mcp`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room', requestId: 'asking-turn', taskId: 'task',
        generationId: 'generation', method: 'tools/call',
        params: { name: 'inject_card', arguments: { item: 'Flowers' } } }),
    });
    expect(response.status).toBe(200);
    await response.json();
    await vi.waitFor(() => expect(decided).toHaveBeenCalledOnce());
  });

  it('delivers a known decision while another Squire call is still running', async () => {
    let notify!: (message: Record<string, unknown>) => void;
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const decided = vi.fn();
    const relay = new SquireTaskRelay('agent', 'room', '', async () => true, '', callbacks => {
      notify = callbacks.onNotification;
      return { close: vi.fn(), requestMcp: async (_method: string, params: { name: string }) => {
        if (params.name === 'operate_observe') {
          started();
          return new Promise(resolve => { finish = resolve; });
        }
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'approval_pending', approval_id: 'purchase-live',
          approval_url: 'https://trustysquire.ai/vault/pay/purchase-live',
        }) }] };
      } } as unknown as StdioSquireMcpClient;
    }, decided);
    cleanups.push(() => relay.close());
    relay.activate({ agentId: 'agent', roomId: 'room', turnRequestId: 'asking-turn',
      rootCommandId: 'task' } as AgentCommand, 'generation');
    const { url, token } = await relay.listen();
    const call = (name: string) => fetch(`${url}/mcp`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room', requestId: 'asking-turn', taskId: 'task',
        generationId: 'generation', method: 'tools/call', params: { name, arguments: {} } }),
    });
    await (await call('inject_card')).json();
    const observing = call('operate_observe');
    await running;
    try {
      notify({ method: 'notifications/approval_decided',
        params: { approval_id: 'purchase-live', status: 'approved' } });
      expect(decided).toHaveBeenCalledOnce();
    } finally {
      finish({});
      expect((await observing).status).toBe(200);
    }
  });
});
