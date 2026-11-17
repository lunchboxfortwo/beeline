import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { callAgentTool } from '../../body/src/read-only-mcp-open-poll.js';
import { itemPrompt } from '../../body/src/place-prompt.js';
import { writeTurnContext } from '../../body/src/place-session.js';
import { TokenAuth, tokenHash } from './auth.js';
import { DaemonService } from './daemon-service.js';
import * as daemonWorkbench from './daemon/workbench.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { migratedDatabase } from './test-support.js';

it('reads an agent’s own long reply parent and searches history through the replying turn context', async () => {
  const db = await migratedDatabase();
  const scratch = await mkdtemp(join(tmpdir(), 'reply-command-authority-'));
  const contextFile = join(scratch, 'turn.json');
  const owner = 'a'.repeat(64), agent = 'b'.repeat(64);
  const workspace = randomUUID(), room = randomUUID();
  const token = 'bdt_reply_command_authority_proof';
  const live = new LiveHub();
  const daemon = DaemonService.fromDependencies({ ...new DaemonService(db, live).dependencies,
    institutionalMemoryShadow: { enabled: true, live: true } });
  const phone = new PhoneService(db, 'http://test');
  vi.spyOn(daemonWorkbench, 'daemonWarmConnectorIndex').mockResolvedValue();
  const server = createBeelineServer({ database: db, daemon, live, phone,
    auth: new TokenAuth(db, async () => { throw new Error('unused'); }), mediaMaximumBytes: 1 });
  try {
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Ruby','ruby')`, [owner, agent]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, owner]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Beeline')`, [workspace]);
    await db.query(`INSERT INTO institutional_memory_workspace_rollouts(workspace_id,stage) VALUES($1,'live')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'beeline')`, [room, workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'member'),($1,$2,$3,'member'),($1,NULL,$4,'owner'),($1,$2,$4,'owner')`, [workspace, room, agent, owner]);
    await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash(token), agent]);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    for (const [key, value] of Object.entries({
      BEELINE_DAEMON_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      BEELINE_DAEMON_TOKEN: token, BEELINE_DAEMON_AGENT_ID: agent,
      BEELINE_DAEMON_ROOM_ID: room, BEELINE_TURN_CONTEXT_FILE: contextFile,
    })) vi.stubEnv(key, value);

    const first = await phone.execute('sendRoomMessage', { roomId: room, text: '@ruby Check Sentry' }, owner);
    const initial = (await daemon.execute('getAgentCommands', { roomId: room }, agent)).commands
      .find(command => command.sourceMessageId === first.messageId)!;
    const question = 'Want me to open a thread for that?';
    const parentText = 'Sentry report: ' + 'Findings and quota details. '.repeat(32) + question;
    const parent = await daemon.execute('postRoomMessage', {
      roomId: room, requestId: initial.turnRequestId, text: parentText,
    }, agent);
    // The parent has fallen outside an ordinary newest-message window.
    await db.query(`UPDATE messages SET created_at=now()-interval '1 day' WHERE id=$1`, [parent.id]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation)
      SELECT 'github-card-'||n,$1,$2,'GitHub opened or merged a pull request','card'
      FROM generate_series(1,60) n`, [room, owner]);
    const sent = await phone.execute('sendRoomReply', {
      roomId: room, parentMessageId: parent.id, text: '@ruby yep',
    }, owner);
    const command = (await daemon.execute('getAgentCommands', { roomId: room }, agent)).commands
      .find(item => item.sourceMessageId === sent.messageId)!;
    expect(command.turnRequestId).toBe(command.id);
    expect(command.reason).toBe('human_tag');
    await writeTurnContext(contextFile, command);

    const readParent = async (requestId?: string) => {
      const request = requestId ? { requestId } : {};
      const result = JSON.parse(await callAgentTool('read', { ...request, facet: 'message', messageId: parent.id }, 'read-parent'));
      expect(result).toMatchObject({ messageId: parent.id, body: parentText });
      const history = JSON.parse(await callAgentTool('search', { ...request, scope: 'history', query: 'Sentry' }, 'search-parent'));
      expect(JSON.stringify(history)).toContain(parent.id);
    };
    await readParent();
    await readParent(command.turnRequestId);
    // Ruby's feedback retained the source message ID as its request ID.
    await readParent(sent.messageId);
    // Finishing the queue item does not revoke subsequent reads by that turn.
    await daemon.execute('postRoomMessage', { roomId: room, requestId: command.turnRequestId, text: 'Opening the thread.' }, agent);
    await readParent();
    await readParent(command.turnRequestId);
    expect(itemPrompt(command, { names: new Map([[owner, 'Owner']]) }))
      .toContain(`In reply to Ruby: ${parentText}`);

    // Reads belong to the current member even when the context has no queue row.
    await writeTurnContext(contextFile, { ...command, turnRequestId: sent.messageId });
    await readParent();
    await writeTurnContext(contextFile, { ...command, roomId: randomUUID(), turnRequestId: 'missing-command' });
    await readParent();
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', join(scratch, 'absent-context.json'));
    await readParent();
    expect(await daemon.execute('getRoomMessage', {
      roomId: room, messageId: parent.id, requestId: 'missing-command',
    }, agent)).toMatchObject({ messageId: parent.id, body: parentText });
    expect((await daemon.execute('searchInstitutionalHistory', {
      roomId: room, agentId: agent, requestId: 'missing-command', query: 'Sentry',
    }, agent)).results.some(item => item.messageId === parent.id)).toBe(true);
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [room, agent]);
    await expect(callAgentTool('read', { facet: 'message', messageId: parent.id }, 'non-member-read'))
      .rejects.toThrow(/403: daemon chat access denied/);
    await expect(callAgentTool('search', { scope: 'history', query: 'Sentry' }, 'non-member-search'))
      .rejects.toThrow(/403: daemon chat access denied/);
    await expect(daemon.execute('getRoomMessage', {
      roomId: room, messageId: parent.id, requestId: 'missing-command',
    }, agent)).rejects.toThrow(/access denied/);
    await expect(daemon.execute('searchInstitutionalHistory', {
      roomId: room, agentId: agent, requestId: 'missing-command', query: 'Sentry',
    }, agent)).rejects.toThrow(/access denied/);
  } finally {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
    await rm(scratch, { recursive: true, force: true });
  }
}, 60_000);
