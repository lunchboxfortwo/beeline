import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { StdioSquireMcpClient } from './squire-mcp-client.js';
import { SquireTaskRelay } from './squire-task-relay.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

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
          itemId: 'generation', method: 'tools/call',
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
        itemId: 'generation', method: 'tools/call',
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
        itemId: 'generation', method: 'tools/call', params: { name, arguments: {} } }),
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
