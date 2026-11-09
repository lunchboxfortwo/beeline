// Run with node --import tsx after building Body and server.
// Isolated database and HTTP bridge to the built daemon; no production writes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migratedDatabase } from '../apps/server/src/test-support.ts';
import { HelperDaemonService } from '../apps/server/dist/test-fixtures/helper-daemon.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { recordMcpMention } from '../apps/server/dist/rooms-mcp-members.js';
import { callAgentTool } from '../apps/body/dist/read-only-mcp.js';

const db = await migratedDatabase();
const owner = 'a'.repeat(64), agent = 'b'.repeat(64), workspace = randomUUID(), room = randomUUID();
const scratch = mkdtempSync(join(tmpdir(), 'agent-tool-proof-'));
const contextFile = join(scratch, 'turn.json');
const daemon = new HelperDaemonService(db, new LiveHub());
const phone = new PhoneService(db, 'http://proof');
daemon.institutionalMemoryShadow.live = true;
const server = createServer(async (req, res) => {
  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const result = await daemon.execute(req.url.split('/').at(-1), JSON.parse(body), agent);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(String(error.message).includes('not found') ? 404 : 400);
    res.end(JSON.stringify({ error: error.message }));
  }
});
try {
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Worker','worker')`, [owner, agent]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agent, owner]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Proof')", [workspace]);
  await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Proof')", [room, workspace]);
  for (const id of [owner, agent]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$3,'owner'),($1,$2,$3,'member')`, [workspace, room, id]);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, { BEELINE_DAEMON_AGENT_ID: agent, BEELINE_DAEMON_ROOM_ID: room,
    BEELINE_DAEMON_BASE_URL: `http://127.0.0.1:${server.address().port}`, BEELINE_DAEMON_TOKEN: 'isolated-proof',
    BEELINE_TURN_CONTEXT_FILE: '', BEELINE_LIB_DIR: '' });
  const send = text => phone.execute('sendRoomMessage', { roomId: room, text }, owner);
  const first = await send('oldest message');
  const tagged = await send('@worker answer this');
  await recordMcpMention(db, agent, room, tagged.messageId);
  const newest = JSON.parse(await callAgentTool('read', { facet: 'messages', limit: 1 }));
  assert.equal(newest.items[0].id, tagged.messageId);
  const oldest = JSON.parse(await callAgentTool('read', { facet: 'messages', from: 'oldest', limit: 1 }));
  assert.equal(oldest.items[0].id, first.messageId);
  const [command] = (await daemon.execute('getAgentCommands', { roomId: room }, agent)).commands;
  await daemon.execute('claimAgentCommand', { roomId: room, commandId: command.id, generationId: 'proof' }, agent);
  const turn = { roomId: room, requestId: command.turnRequestId, generationId: 'proof' };
  writeFileSync(contextFile, JSON.stringify({ ...turn, commandReason: command.reason }));
  process.env.BEELINE_TURN_CONTEXT_FILE = contextFile;
  const procedure = JSON.parse(await callAgentTool('read', { facet: 'procedure', name: 'beeline-memory' }));
  assert.equal(procedure.slug, 'beeline-memory');
  await phone.execute('sendRoomReply', { roomId: room, text: 'answer', parentMessageId: tagged.messageId }, agent);
  await db.query('DELETE FROM rooms_mcp_mentions WHERE member_id=$1 AND message_id=$2', [agent, tagged.messageId]);
  await recordMcpMention(db, agent, room, tagged.messageId);
  assert(!(await daemon.execute('getOwedMentions', {}, agent)).owedMentions.some(m => m.messageId === tagged.messageId));
  const pending = randomBytes(32).toString('hex');
  await db.query("INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'pending tag')", [pending, room, owner]);
  await recordMcpMention(db, agent, room, pending);
  assert((await daemon.execute('getOwedMentions', {}, agent)).owedMentions.some(m => m.messageId === pending));
  await db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [room, agent]);
  assert.deepEqual((await daemon.execute('getOwedMentions', {}, agent)).owedMentions, []);
  await db.query('UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2', [room, agent]);
  console.log('PASS Reproduction 7: next daemon tool result omits answered and unreadable tags; pending readable tags survive.');
  const created = await daemon.execute('createAgentSchedule', { ...turn, title: 'Keep this title', roomId: room,
    prompt: 'Original task', cadence: { kind: 'interval', everyMinutes: 60 } }, agent);
  await daemon.execute('updateAgentSchedule', { ...turn, scheduleId: created.scheduleId, prompt: 'Changed task' }, agent);
  assert((await daemon.execute('listAgentSchedules', { roomId: room }, agent)).schedules.some(s => s.title === 'Keep this title' && s.prompt === 'Changed task'));
  const issue = await phone.execute('reportMessageIssue', { roomId: room, messageId: first.messageId }, owner);
  daemon.feedback.config = { repository: 'Beeline-Work/beeline', systemSenders: [] };
  daemon.feedback.pullRequests = { merged: async () => true };
  assert.deepEqual(await daemon.execute('notifyFeedbackFixed', { ...turn, itemIds: [issue.itemId], title: 'Fixed tools',
    prUrl: 'https://github.com/Beeline-Work/beeline/pull/7' }, agent), { resolved: 1, notified: 0 });
  const decision = await daemon.execute('postSquireApprovalDecision', { ...turn, approvalId: 'proof', status: 'approved',
    tool: 'proof', title: 'Approval', detail: 'Approved' }, agent);
  const resume = (await daemon.execute('getAgentCommands', { roomId: room }, agent)).commands.find(c => c.sourceMessageId === decision.id);
  assert(resume);
  await daemon.execute('claimAgentCommand', { roomId: room, commandId: resume.id, generationId: 'resumed' }, agent);
  writeFileSync(contextFile, JSON.stringify({ roomId: room, requestId: resume.turnRequestId, generationId: 'resumed', commandReason: resume.reason }));
  assert.deepEqual(JSON.parse(await callAgentTool('no_reply_needed', {})), { acknowledged: true });
  assert.equal((await db.query("SELECT completion_kind FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3", [room, resume.turnRequestId, agent])).rows[0].completion_kind, 'no-reply');
  console.log('PASS tool-traps: built Body HTTP reads default newest and accept procedure name; built schedule list preserves title; merged-provider fixture resolves silently without System senders; Squire resume closes through Body no_reply_needed.');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await db.close();
  rmSync(scratch, { recursive: true, force: true });
}
