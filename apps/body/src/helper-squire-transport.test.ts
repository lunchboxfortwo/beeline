import { expect, it, vi } from 'vitest';
import { HelperSquireTransport, type SquireMcpClientOptions, StdioSquireMcpClient } from './squire-mcp-client.js';
import { registerSquireSession, squireSessionOwner, squireSessionInheritable, tagSquireSessionSchedule, forgetSquireSessions } from './squire-session-registry.js';

it('shares one wire while retaining place ownership, schedule lineage and pending approvals after a peer closes', async () => {
  let callbacks!: SquireMcpClientOptions;
  const requestMcp = vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }));
  const close = vi.fn();
  const make = vi.fn((options: SquireMcpClientOptions) => {
    callbacks = options;
    return { requestMcp, close } as unknown as StdioSquireMcpClient;
  });
  const transport = new HelperSquireTransport('/isolated-home', make);
  const notifyA = vi.fn(), notifyB = vi.fn();
  const a = transport.acquire({ scope: { agentId: 'agent', roomId: 'a' }, onNotification: notifyA });
  const b = transport.acquire({ scope: { agentId: 'agent', roomId: 'b' }, onNotification: notifyB });
  try {
    expect(make).toHaveBeenCalledOnce();
    await Promise.all([a.requestMcp('tools/list', {}), b.requestMcp('tools/list', {})]);
    expect(requestMcp).toHaveBeenCalledTimes(2);
    registerSquireSession('session-from-a', { agentId: 'agent', conversationId: 'a', client: a });
    expect(squireSessionOwner('session-from-a')?.client).toBe(a);
    expect(squireSessionOwner('session-from-a')?.client).not.toBe(b);
    expect(squireSessionInheritable('session-from-a', 'agent', 'b', 'schedule')).toBe(false);
    expect(squireSessionInheritable('session-from-a', 'agent', 'a', 'schedule')).toBe(true);
    tagSquireSessionSchedule('session-from-a', 'schedule');
    expect(squireSessionInheritable('session-from-a', 'agent', 'b', 'schedule')).toBe(true);
    expect(squireSessionInheritable('session-from-a', 'agent', 'a', 'other-schedule')).toBe(false);
    b.close();
    expect(close).not.toHaveBeenCalled();
    callbacks.onNotification!({ method: 'notifications/approval_decided', params: { approval_id: 'pending' } });
    expect(notifyA).toHaveBeenCalledOnce();
    expect(notifyB).not.toHaveBeenCalled();
    await a.requestMcp('tools/call', { name: 'operate_observe', arguments: { session_id: 'session-from-a' } });
  } finally { forgetSquireSessions(['session-from-a']); transport.close(); }
  expect(close).toHaveBeenCalledOnce();
});

it('keeps implicit browser selection, approvals, schedules and cleanup in the requesting place', async () => {
  const { SquireTaskRelay } = await import('./squire-task-relay.js');
  const approvalsA = vi.fn(), approvalsB = vi.fn();
  let callbacks!: SquireMcpClientOptions;
  let id = 0;
  const requestMcp = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    const args = params.arguments as Record<string, unknown>;
    return { content: [{ type: 'text', text: JSON.stringify(params.name === 'operate_start'
      ? { session_id: `browser-session-${++id}` }
      : params.name === 'inject_card' ? { status: 'approval_pending', approval_id: `approval-${args.session_id}`,
          approval_url: `https://trustysquire.ai/vault/pay/approval-${args.session_id}` }
      : { session_id: args.session_id }) }] };
  });
  const wireClose = vi.fn();
  const transport = new HelperSquireTransport('/isolated', options => {
    callbacks = options; return { requestMcp, close: wireClose } as unknown as StdioSquireMcpClient;
  });
  const relay = (room: string, decision: typeof approvalsA) => new SquireTaskRelay('agent', room, '', async () => true, '',
    callbacks => transport.acquire({ scope: { agentId: 'agent', roomId: room }, ...callbacks }), decision);
  const a = relay('a', approvalsA), b = relay('b', approvalsB);
  const command = (roomId: string, scheduleId?: string) => ({ agentId: 'agent', roomId, turnRequestId: roomId,
    rootCommandId: roomId, ...(scheduleId ? { scheduleId } : {}) }) as import('@beeline/api-contract/daemon').AgentCommand;
  a.activate(command('a', 'schedule-a'), 'item'); b.activate(command('b'), 'item');
  const endpointA = await a.listen(), endpointB = await b.listen();
  const call = async (endpoint: typeof endpointA, roomId: string, name: string, args: Record<string, unknown>) => {
    const response = await fetch(`${endpoint.url}/mcp`, { method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, requestId: roomId, taskId: roomId, itemId: 'item', method: 'tools/call', params: { name, arguments: args } }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    expect((await call(endpointA, 'a', 'operate_start', { service_url: 'https://a.test' })).status).toBe(200);
    expect((await call(endpointB, 'b', 'operate_drive', { goal: 'implicit foreign browser' })).status).toBe(400);
    expect((await call(endpointA, 'a', 'operate_drive', { goal: 'own browser' })).status).toBe(200);
    expect(requestMcp).toHaveBeenLastCalledWith('tools/call', { name: 'operate_drive', arguments: { goal: 'own browser', session_id: 'browser-session-1' } });
    expect((await call(endpointB, 'b', 'operate_observe', { session_id: 'browser-session-1' })).status).toBe(400);
    // A run of the same schedule may inherit its prior browser across places.
    b.activate(command('b', 'schedule-a'), 'item');
    expect((await call(endpointB, 'b', 'operate_observe', { session_id: 'browser-session-1' })).status).toBe(200);
    b.activate(command('b'), 'item');
    await call(endpointB, 'b', 'operate_start', { service_url: 'https://b.test' });
    await call(endpointA, 'a', 'inject_card', { session_id: 'browser-session-1' });
    await call(endpointB, 'b', 'inject_card', { session_id: 'browser-session-2' });
    callbacks.onNotification!({ method: 'notifications/approval_decided', params: { approval_id: 'approval-browser-session-1', status: 'approved' } });
    expect(approvalsA).toHaveBeenCalledOnce(); expect(approvalsB).not.toHaveBeenCalled();
    a.close();
    expect(requestMcp).toHaveBeenCalledWith('tools/call', { name: 'operate_finish', arguments: { session_id: 'browser-session-1' } });
    expect(wireClose).not.toHaveBeenCalled();
    expect((await call(endpointB, 'b', 'operate_observe', { session_id: 'browser-session-2' })).status).toBe(200);
  } finally { a.close(); b.close(); transport.close(); }
});
