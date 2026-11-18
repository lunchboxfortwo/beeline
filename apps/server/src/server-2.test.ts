import { phoneFetch, AddressInfo, WebSocket, describe, expect, it, vi, WorkspaceSkillNotFoundError, LiveHub, createBeelineServer, canReadRoomsFrom, nextSocketMessage, expectNoSocketMessageOfType, expectNoSocketMessage, fixtureScope2, fixtureScope3, fixtureScope4, type TokenAuth, type PhoneService, type DaemonService } from './test-support-server.test-support.js';

describe('daemon live command push', () => {
const scope2 = fixtureScope2();


  it('answers a phone ping with a pong without touching the database', async () => {
    const query = vi.fn();
    const server = createBeelineServer({
      database: { query, transaction: vi.fn() },
      auth: { authenticatePhone: vi.fn().mockResolvedValue('reader') } as unknown as TokenAuth,
      phone: { canReadRooms: canReadRoomsFrom(async () => true) } as unknown as PhoneService,
      daemon: { execute: vi.fn() } as unknown as DaemonService,
      live: new LiveHub(),
      mediaMaximumBytes: 1,
    });
    scope2.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone-token']);
    scope2.sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    query.mockClear();
    const pong = nextSocketMessage(socket, 'pong');
    socket.send(JSON.stringify({ type: 'ping' }));
    await expect(pong).resolves.toEqual({ type: 'pong' });
    const synced = nextSocketMessage(socket, 'sync-ok');
    socket.send(JSON.stringify({ type: 'sync' }));
    await expect(synced).resolves.toEqual({ type: 'sync-ok' });
    expect(query).not.toHaveBeenCalled();
  });

  it('handles a failed phone lease renewal while continuing to answer socket traffic', async () => {
    const failure = new Error('timeout exceeded when trying to connect');
    const renewLease = vi.fn().mockRejectedValue(failure);
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const server = createBeelineServer({
        database: { query: vi.fn(), transaction: vi.fn() },
        auth: { authenticatePhone: vi.fn().mockResolvedValue('reader') } as unknown as TokenAuth,
        phone: { canReadRooms: canReadRoomsFrom(async () => true) } as unknown as PhoneService,
        daemon: { execute: vi.fn() } as unknown as DaemonService,
        connectionPresence: { holdServerConnection: () => () => {}, renewLease } as never,
        live: new LiveHub(), mediaMaximumBytes: 1,
      });
      scope2.servers.push(server);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/phone/live`, ['bearer.phone-token']);
      scope2.sockets.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      const pong = nextSocketMessage(socket, 'pong');
      socket.send(JSON.stringify({ type: 'ping' }));
      await expect(pong).resolves.toEqual({ type: 'pong' });
      expect(renewLease).toHaveBeenCalledOnce();
      expect(report).toHaveBeenCalledWith('[live] lease renewal failed', failure);
    } finally { report.mockRestore(); }
  });
});
describe('daemon HTTP operations', () => {
const scope3 = fixtureScope3();


  it('answers a missing Workspace procedure slug with 404 and the slug, not 503', async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(new WorkspaceSkillNotFoundError('never-saved-procedure'));
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: {
        authenticatePhone: vi.fn().mockResolvedValue(null),
        authenticateDaemon: vi.fn().mockResolvedValue('agent'),
      } as unknown as TokenAuth,
      phone: {} as PhoneService,
      daemon: { execute } as unknown as DaemonService,
      live: new LiveHub(),
      mediaMaximumBytes: 1,
    });
    scope3.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await phoneFetch(
      `http://127.0.0.1:${port}/v1/daemon/operations/loadWorkspaceSkill`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer bdt_${'t'.repeat(43)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ roomId: 'room', slug: 'never-saved-procedure' }),
      },
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'workspace skill never-saved-procedure not found',
    });
  });


  it.each(['getAgentCommands', 'getRoomGitHubToken', 'authorizeResourceCall'] as const)(
    '%s does not rewrite presence for an HTTP request', async name => {
    const evidence = vi.fn(async () => {});
    const query = vi.fn();
    const execute = vi.fn().mockResolvedValue({});
    const server = createBeelineServer({
      database: { query, transaction: vi.fn() },
      auth: {
        authenticatePhone: vi.fn().mockResolvedValue(null),
        authenticateDaemon: vi.fn().mockResolvedValue('agent'),
      } as unknown as TokenAuth,
      phone: {} as PhoneService,
      daemon: { execute } as unknown as DaemonService,
      live: new LiveHub(),
      connectionPresence: { evidence } as never,
      mediaMaximumBytes: 1,
    });
    scope3.servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    for (let call = 0; call < 3; call++) {
      const response = await phoneFetch(`http://127.0.0.1:${port}/v1/daemon/operations/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer bdt_${'t'.repeat(43)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: 'room' }),
      });
      expect(response.status).toBe(200);
      await response.json();
    }
    expect(execute).toHaveBeenCalledTimes(3);
    expect(evidence).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
describe('phone committed-row live delivery', () => {
const scope4 = fixtureScope4();


  it('sends complete small messages to opted-in offscreen Room caches', async () => {
    const delta = { type: 'message-delta', roomId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      message: { id: 'b'.repeat(64), text: 'new arrival', createdAt: 1, presentation: 'message',
        author: { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Agent' } } };
    const { live, socket } = await scope4.connect(vi.fn().mockResolvedValue(delta),
      undefined, undefined, false, undefined, undefined, undefined, undefined, undefined, {}, true, delta.roomId);
    const frame = nextSocketMessage(socket, 'message-delta');
    live.publish({ type: 'invalidate', roomId: delta.roomId, reason: 'message', messageId: 'small' });
    const wire = await frame;
    expect(wire).toMatchObject(delta);

  });


  it('NET-HOL-1 sends bounded previews only to opted-in offscreen subscriptions', async () => {
    const roomId = 'room-live';
    const text = 'B'.repeat(128 * 1024);
    const read = vi.fn().mockResolvedValue({ type: 'message-delta', roomId,
      message: { id: 'large', text, createdAt: 1, presentation: 'message',
        author: { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Agent' },
        mentionPubkeys: ['viewer'], attachments: [{ data: text }] } });
    const legacy = await scope4.connect(read);
    const modern = await scope4.connect(read, undefined, undefined, false, undefined,
      undefined, undefined, undefined, undefined, {}, true);
    const legacyFrame = nextSocketMessage(legacy.socket, 'message-delta');
    const previewFrame = nextSocketMessage(modern.socket, 'sidebar-preview');
    legacy.live.publish({ type: 'invalidate', roomId, reason: 'message', messageId: 'large' });
    modern.live.publish({ type: 'invalidate', roomId, reason: 'message', messageId: 'large' });
    expect((await legacyFrame).message.text).toHaveLength(128 * 1024);
    const preview = await previewFrame;
    expect(preview.preview.text).toHaveLength(240);
    expect(preview.preview.mentionsViewer).toBe(true);
    expect(preview).not.toHaveProperty('message');
    expect(preview.preview).not.toHaveProperty('attachments');
    expect(JSON.stringify(preview).length).toBeLessThan(2000);
  });


  it('keeps viewed Room messages complete after opting into sidebar previews', async () => {
    const roomId = '00000000-0000-4000-8000-000000000123';
    // This is the legacy message/sidebar wire path. Viewing still publishes
    // an aggregate overlay revision when the server router is enabled.
    const query = vi.fn().mockImplementation(async (sql: string) => ({ rowCount: 1,
      rows: sql.includes('FROM helper_overlay_demand') ? [{ revision: '1', viewing: true }] : [] }));
    const read = vi.fn().mockImplementation(async () => ({ type: 'message-delta', roomId,
      message: { id: 'viewed', text: 'V'.repeat(128 * 1024), createdAt: 1,
        presentation: 'message', author: { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Agent' } } }));
    const { live, socket } = await scope4.connect(read, undefined, undefined, false, query);
    const subscribed = nextSocketMessage(socket, 'subscribed');
    socket.send(JSON.stringify({ type: 'viewing', roomId, viewing: true }));
    socket.send(JSON.stringify({ type: 'subscribe', roomId, sidebarPreviews: true }));
    await subscribed;
    const frame = nextSocketMessage(socket, 'message-delta');
    live.publish({ type: 'invalidate', roomId, reason: 'message', messageId: 'viewed' });
    expect((await frame).message.text).toHaveLength(128 * 1024);
    socket.send(JSON.stringify({ type: 'viewing', roomId, viewing: false }));
    await vi.waitFor(() => expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM room_push_views'))).toBe(true));
    const preview = nextSocketMessage(socket, 'sidebar-preview');
    read.mockResolvedValueOnce({ type: 'message-delta', roomId, message: {
      id: 'after-leaving', text: 'S'.repeat(128 * 1024), createdAt: 2, presentation: 'message',
      author: { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Agent' } } });
    live.publish({ type: 'invalidate', roomId, reason: 'message', messageId: 'after-leaving' });
    expect((await preview).preview.text).toHaveLength(240);
  });


  it('projects a parent corner status into one compact frame', async () => {
    const status = { cornerCount: 1, waitingCornerCount: 1,
      openCorners: [{ id: 'corner', name: 'Fix', state: 'waiting' as const }],
      agentState: 'needs-you' as const };
    const project = vi.fn().mockResolvedValue(status);
    const { live, roomId, socket } = await scope4.connect(
      vi.fn() as PhoneService['readLiveDelta'], undefined, undefined, false, undefined,
      project as PhoneService['liveChatCornerStatus']);
    const frame = nextSocketMessage(socket, 'corner-status');
    live.publish({ type: 'invalidate', roomId, reason: 'corner-status' });
    await expect(frame).resolves.toEqual({ type: 'corner-status', roomId, ...status });
    expect(project).toHaveBeenCalledWith(roomId, 'viewer');
    const noDuplicate = expectNoSocketMessage(socket);
    live.publish({ type: 'invalidate', roomId, reason: 'corner-status' });
    await noDuplicate;
    expect(project).toHaveBeenCalledTimes(2);
  });


  it('drops a message projection whose version is not newer than the one sent', async () => {
    const roomId = 'room-live';
    const delta = (text: string) => ({ type: 'message-delta' as const, roomId,
      version: 1, message: { id: 'edited', text, createdAt: 1,
        author: { pubkey: 'agent', kind: 'agent' as const, name: 'Agent' },
        presentation: 'message' as const } });
    const batch = vi.fn()
      .mockImplementationOnce(async (_roomId, viewers: string[]) =>
        new Map(viewers.map((viewer) => [viewer, delta('first')])))
      .mockImplementationOnce(async (_roomId, viewers: string[]) =>
        new Map(viewers.map((viewer) => [viewer, delta('other content')])));
    const { live, socket } = await scope4.connect(
      vi.fn() as PhoneService['readLiveDelta'], undefined, undefined, false,
      undefined, undefined, batch as PhoneService['readLiveDeltas']);
    const first = nextSocketMessage(socket, 'message-delta');
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages', messageId: 'edited' });
    await expect(first).resolves.toMatchObject({ version: 1, message: { text: 'first' } });
    const nothingEqual = expectNoSocketMessageOfType(socket, 'message-delta', 100);
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages', messageId: 'edited' });
    await nothingEqual;
    expect(batch).toHaveBeenCalledTimes(2);
  });


  it.each([1, 2, 8])('reads a cross-process row once for %i sockets', async (count) => {
    const roomId = 'room-live';
    const delta = { type: 'message-delta' as const, roomId,
      message: { id: 'one-row', text: 'hello', createdAt: 1,
        author: { pubkey: 'agent', kind: 'agent' as const, name: 'Agent' },
        presentation: 'message' as const } };
    const batch = vi.fn().mockImplementation(async (_roomId, viewers: string[]) =>
      new Map(viewers.map((viewer) => [viewer, delta])));
    const read = vi.fn().mockRejectedValue(new Error('per-socket read'));
    const { live, socket, port } = await scope4.connect(
      read as PhoneService['readLiveDelta'], undefined, undefined, false,
      undefined, undefined, batch as PhoneService['readLiveDeltas']);
    const viewers = [socket];
    for (let index = 1; index < count; index++) {
      const next = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone']);
      scope4.sockets.push(next);
      await new Promise<void>((resolve, reject) => {
        next.once('open', resolve);
        next.once('error', reject);
      });
      const subscribed = nextSocketMessage(next, 'subscribed');
      next.send(JSON.stringify({ type: 'subscribe', roomId }));
      await subscribed;
      viewers.push(next);
    }
    const frames = viewers.map((viewer) => nextSocketMessage(viewer, 'message-delta'));
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages',
      operation: 'INSERT', messageId: 'one-row' });
    for (const frame of frames) await expect(frame).resolves.toMatchObject(delta);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    await Promise.all(viewers.map((viewer) => expectNoSocketMessage(viewer, 50)));
  });


  it('sends a same-machine turn with the rolled-up agent state of the row read', async () => {
    const roomId = 'room-live';
    const turnDelta = { type: 'turn-delta' as const, roomId, agentState: 'working' as const,
      turn: { agentId: 'agent', requestId: 'request', status: 'working' as const,
        startedAt: 1, createdAt: 1 } };
    const batch = vi.fn(async (_roomId: string, viewers: string[]) =>
      new Map(viewers.map((viewer) => [viewer, turnDelta])));
    const { live, socket } = await scope4.connect(
      vi.fn() as PhoneService['readLiveDelta'], undefined, undefined, false,
      undefined, undefined, batch as unknown as PhoneService['readLiveDeltas']);
    const frame = nextSocketMessage(socket, 'turn-delta');
    live.publish({ type: 'invalidate', roomId, reason: 'turn', agentId: 'agent',
      requestId: 'request', committedRow: { type: 'turn', row: {
        room_id: roomId, request_id: 'request', agent_id: 'agent', status: 'working',
        started_at: new Date(1), created_at: new Date(1),
        requested_by: null } } });
    await expect(frame).resolves.toMatchObject({ type: 'turn-delta', agentState: 'working' });
    expect(batch).toHaveBeenCalledTimes(1);
  });


  it('never revives a completed turn when its working read finishes last', async () => {
    const roomId = 'room-live';
    const turn = { agentPubkey: 'b'.repeat(64), requestId: 'a0ca7bfd',
      status: 'working' as const, startedAt: 1794928215, createdAt: 1794928215, version: 0 };
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const batch = vi.fn()
      .mockImplementationOnce(async (_roomId, viewers: string[]) => {
        await held;
        return new Map(viewers.map(viewer => [viewer, { type: 'turn-delta', roomId, turn }]));
      })
      .mockImplementationOnce(async (_roomId, viewers: string[]) => new Map(viewers.map(viewer => [viewer,
        { type: 'turn-delta', roomId, turn: { ...turn, status: 'complete', createdAt: 1794928320, version: 1 } }])));
    const { live, socket } = await scope4.connect(vi.fn() as PhoneService['readLiveDelta'],
      undefined, undefined, false, undefined, undefined, batch as PhoneService['readLiveDeltas']);
    const complete = nextSocketMessage(socket, 'turn-delta');
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:agent_turns', agentId: turn.agentPubkey, requestId: turn.requestId });
    live.publish({ type: 'invalidate', roomId, reason: 'turn', agentId: turn.agentPubkey, requestId: turn.requestId });
    await expect(complete).resolves.toMatchObject({ turn: { status: 'complete' } });
    const noRevival = expectNoSocketMessageOfType(socket, 'turn-delta', 100);
    release();
    await noRevival;
    expect(batch).toHaveBeenCalledTimes(2);
  });

  it('never sends an older projection of a message after a newer one', async () => {
    const roomId = 'room-live';
    const delta = (text: string, version: number) => ({ type: 'message-delta' as const, roomId,
      version, message: { id: 'edited', text, createdAt: 1,
        author: { pubkey: 'agent', kind: 'agent' as const, name: 'Agent' },
        presentation: 'message' as const } });
    let releaseOlder!: () => void;
    const olderRead = new Promise<void>((resolve) => { releaseOlder = resolve; });
    // The first edit's read starts first but finishes after the second edit's read.
    const batch = vi.fn()
      .mockImplementationOnce(async (_roomId, viewers: string[]) => {
        await olderRead;
        return new Map(viewers.map((viewer) => [viewer, delta('first edit', 1)]));
      })
      .mockImplementationOnce(async (_roomId, viewers: string[]) =>
        new Map(viewers.map((viewer) => [viewer, delta('second edit', 2)])));
    const { live, socket } = await scope4.connect(
      vi.fn() as PhoneService['readLiveDelta'], undefined, undefined, false,
      undefined, undefined, batch as PhoneService['readLiveDeltas']);
    const newer = nextSocketMessage(socket, 'message-delta');
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages', messageId: 'edited' });
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages', messageId: 'edited' });
    await expect(newer).resolves.toMatchObject({ version: 2, message: { text: 'second edit' } });
    const nothingOlder = expectNoSocketMessageOfType(socket, 'message-delta', 100);
    releaseOlder();
    await nothingOlder;
    expect(batch).toHaveBeenCalledTimes(2);
  });


  it('keeps a message version while its older read is in flight past 256 other rows', async () => {
    const roomId = 'room-live';
    const delta = (id: string, text: string, version: number) => ({
      type: 'message-delta' as const, roomId, version, message: { id, text, createdAt: 1,
        author: { pubkey: 'agent', kind: 'agent' as const, name: 'Agent' },
        presentation: 'message' as const } });
    let releaseOlder!: () => void;
    const olderRead = new Promise<void>((resolve) => { releaseOlder = resolve; });
    const batch = vi.fn()
      .mockImplementationOnce(async (_roomId, viewers: string[]) => {
        await olderRead;
        return new Map(viewers.map((viewer) => [viewer, delta('edited', 'first edit', 1)]));
      })
      .mockImplementationOnce(async (_roomId, viewers: string[]) =>
        new Map(viewers.map((viewer) => [viewer, delta('edited', 'second edit', 2)])))
      .mockImplementation(async (_roomId, viewers: string[], target: { messageId: string }) =>
        new Map(viewers.map((viewer) => [viewer, delta(target.messageId, 'other', 1)])));
    const { live, socket } = await scope4.connect(
      vi.fn() as PhoneService['readLiveDelta'], undefined, undefined, false,
      undefined, undefined, batch as PhoneService['readLiveDeltas']);
    const newer = nextSocketMessage(socket, 'message-delta');
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages', messageId: 'edited' });
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages', messageId: 'edited' });
    await expect(newer).resolves.toMatchObject({ version: 2, message: { text: 'second edit' } });
    const others: unknown[] = [];
    const sawOthers = new Promise<void>((resolve) => {
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type !== 'message-delta') return;
        others.push(frame);
        if (others.length === 256) resolve();
      });
    });
    for (let index = 0; index < 256; index++)
      live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages',
        messageId: `other-${index}` });
    await sawOthers;
    const nothingOlder = expectNoSocketMessageOfType(socket, 'message-delta', 100);
    releaseOlder();
    await nothingOlder;
  });


  it('sends owner-scoped resource changes on the shared phone socket', async () => {
    const { live, socket } = await scope4.connect(vi.fn() as PhoneService['readLiveDelta']);
    const frame = nextSocketMessage(socket, 'resource-change');
    live.publish({ type: 'resource-change', roomId: '', ownerId: 'viewer',
      resource: 'workbench', resourceId: 'connection' });
    await expect(frame).resolves.toEqual({ type: 'resource-change', roomId: '',
      resource: 'workbench', resourceId: 'connection' });
    const noLeak = expectNoSocketMessage(socket, 100);
    live.publish({ type: 'resource-change', roomId: '', ownerId: 'other',
      resource: 'agent', resourceId: 'other-agent' });
    await noLeak;
  });


  it('sends a Workspace header change only to its members, reading it once', async () => {
    const liveWorkspaceChange = vi.fn()
      .mockResolvedValueOnce({ workspace: { id: 'workspace', name: 'Renamed' },
        viewers: new Set(['viewer']) })
      .mockResolvedValueOnce({ workspace: { id: 'other', name: 'Theirs' },
        viewers: new Set(['someone-else']) });
    const { live, socket } = await scope4.connect(
      vi.fn() as PhoneService['readLiveDelta'], undefined, undefined, false,
      undefined, undefined, undefined, undefined, undefined,
      { liveWorkspaceChange } as Partial<PhoneService>);
    const frame = nextSocketMessage(socket, 'workspace-changed');
    live.publish({ type: 'invalidate', roomId: '', reason: 'postgres:workspaces',
      workspaceId: 'workspace' });
    await expect(frame).resolves.toEqual({ type: 'workspace-changed', roomId: '',
      workspace: { id: 'workspace', name: 'Renamed' } });
    const noLeak = expectNoSocketMessage(socket, 100);
    live.publish({ type: 'invalidate', roomId: '', reason: 'postgres:workspaces',
      workspaceId: 'other' });
    await noLeak;
    expect(liveWorkspaceChange).toHaveBeenCalledTimes(2);
  });


  it('sends a person change to who shares a scope, and the push level only to its owner', async () => {
    const person = { pubkey: 'mate', kind: 'human' as const, name: 'Mate Renamed' };
    const self = { pubkey: 'viewer', kind: 'human' as const, name: 'Viewer' };
    const livePersonChange = vi.fn().mockImplementation(async (personId: string) =>
      personId === 'mate' ? { person, pushLevel: 'full', viewers: new Set(['mate', 'viewer']) }
        : personId === 'viewer' ? { person: self, pushLevel: 'off', viewers: new Set(['viewer']) }
          : { person: { ...person, pubkey: 'stranger' }, pushLevel: 'attention',
            viewers: new Set(['stranger']) });
    const { live, socket } = await scope4.connect(
      vi.fn() as PhoneService['readLiveDelta'], undefined, undefined, false,
      undefined, undefined, undefined, undefined, undefined,
      { livePersonChange } as Partial<PhoneService>);
    const mate = nextSocketMessage(socket, 'person-changed');
    live.publish({ type: 'invalidate', roomId: '', reason: 'postgres:identities', personId: 'mate' });
    await expect(mate).resolves.toEqual({ type: 'person-changed', roomId: '', person });
    const own = nextSocketMessage(socket, 'person-changed');
    live.publish({ type: 'invalidate', roomId: '', reason: 'postgres:identities', personId: 'viewer' });
    await expect(own).resolves.toEqual({ type: 'person-changed', roomId: '', person: self,
      pushLevel: 'off' });
    const noLeak = expectNoSocketMessage(socket, 100);
    live.publish({ type: 'invalidate', roomId: '', reason: 'postgres:identities',
      personId: 'stranger' });
    await noLeak;
  });


  it('reads a bookmark once and sends the typed change to both devices', async () => {
    const bookmark = { messageId: 'saved', workspaceId: 'workspace', roomId: 'room-live',
      roomName: 'Room', roomKind: 'room' as const, messageCreatedAt: 1,
      bookmarkedAt: 2, available: true };
    const read = vi.fn().mockResolvedValue(bookmark);
    const { live, socket, port } = await scope4.connect(
      vi.fn() as PhoneService['readLiveDelta'], undefined, undefined, false,
      undefined, undefined, undefined, read as PhoneService['readLiveBookmark']);
    const second = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone']);
    scope4.sockets.push(second);
    await new Promise<void>((resolve, reject) => {
      second.once('open', resolve);
      second.once('error', reject);
    });
    const firstFrame = nextSocketMessage(socket, 'bookmark-delta');
    const secondFrame = nextSocketMessage(second, 'bookmark-delta');
    live.publish({ type: 'invalidate', roomId: '', reason: 'postgres:message_bookmarks',
      readerId: 'viewer', workspaceId: 'workspace', messageId: 'saved' });
    await expect(firstFrame).resolves.toMatchObject({ bookmark, messageId: 'saved' });
    await expect(secondFrame).resolves.toMatchObject({ bookmark, messageId: 'saved' });
    expect(read).toHaveBeenCalledTimes(1);
    const removed = nextSocketMessage(socket, 'bookmark-delta');
    live.publish({ type: 'invalidate', roomId: '', reason: 'postgres:message_bookmarks',
      readerId: 'viewer', workspaceId: 'workspace', messageId: 'saved', operation: 'DELETE' });
    await expect(removed).resolves.toMatchObject({ messageId: 'saved', bookmark: null });
    expect(read).toHaveBeenCalledTimes(1);
  });


  it('sends one server-derived Needs-you room slice to each device', async () => {
    const roomId = 'room-live';
    const message = { id: 'ask', text: 'needs-decision: please review', createdAt: 1,
      author: { pubkey: 'agent', kind: 'agent' as const, name: 'Agent' },
      presentation: 'message' as const, mentionPubkeys: ['viewer'] };
    const batch = vi.fn().mockImplementation(async (_roomId, viewers: string[]) =>
      new Map(viewers.map((viewer) => [viewer,
        { type: 'message-delta', roomId, message }])));
    const needs = { workspaceId: 'workspace', count: 1,
      items: [{ messageId: 'ask', workspaceId: 'workspace', roomId,
        roomName: 'Room', roomKind: 'room', text: 'please review', createdAt: 1 }] };
    const readNeeds = vi.fn().mockResolvedValue(needs);
    const { live, socket, port } = await scope4.connect(
      vi.fn() as PhoneService['readLiveDelta'], undefined, undefined, false,
      undefined, undefined, batch as PhoneService['readLiveDeltas'],
      undefined, readNeeds as PhoneService['liveNeedsYou']);
    const second = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone']);
    scope4.sockets.push(second);
    await new Promise<void>((resolve, reject) => {
      second.once('open', resolve);
      second.once('error', reject);
    });
    const subscribed = nextSocketMessage(second, 'subscribed');
    second.send(JSON.stringify({ type: 'subscribe', roomId }));
    await subscribed;
    const first = nextSocketMessage(socket, 'needs-you-delta');
    const next = nextSocketMessage(second, 'needs-you-delta');
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages',
      operation: 'INSERT', messageId: 'ask', needsYouCandidate: true,
      agentId: 'agent' });
    await expect(first).resolves.toMatchObject({ type: 'needs-you-delta', count: 1,
      sourceRoomId: roomId, items: needs.items });
    await expect(next).resolves.toMatchObject({ type: 'needs-you-delta', count: 1 });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(readNeeds).toHaveBeenCalledTimes(1);
  });
});
