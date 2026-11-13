// Build the server first, then run: node --import tsx scripts/prove-owed-tags.mjs
// Historical production shapes in an isolated database; no production writes.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { migratedDatabase } from '../apps/server/src/test-support.ts';
import { createBeelineServer } from '../apps/server/dist/server.js';
import { HelperDaemonService } from '../apps/server/dist/test-fixtures/helper-daemon.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { TokenAuth } from '../apps/server/dist/auth.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { routeHumanMessage } from '../apps/server/dist/agent-command.js';
import { recordMcpMention } from '../apps/server/dist/rooms-mcp-members.js';

const db = await migratedDatabase();
const ruby = 'c3dfbf8acbb4b6e9f11bd37119a5ce2f4f104257885d098d8e075c0b0c4c066b';
const owner = 'a'.repeat(64), other = 'b'.repeat(64), workspace = randomUUID(), room = randomUUID();
const id = () => randomBytes(32).toString('hex');
const token = id(), live = new LiveHub();
const phone = new PhoneService(db, 'http://localhost', undefined, undefined, live);
const daemon = new HelperDaemonService(db, live);
const auth = new TokenAuth(db, async () => { throw new Error('unused'); });
const server = createBeelineServer({ database: db, auth, phone, daemon, live, mediaMaximumBytes: 1024 });
try {
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Proof owner','play-review'),($2,'agent','Ruby','ruby'),($3,'agent','Other','claude')`, [owner, ruby, other]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)', [ruby, other, owner]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Isolated owed-tags proof')", [workspace]);
  await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Proof')", [room, workspace]);
  for (const who of [owner, ruby, other]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$3,'owner'),($1,$2,$3,'member')`, [workspace, room, who]);
  await db.query('INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)', [createHash('sha256').update(token).digest('hex'), ruby]);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const read = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/daemon/owed-mentions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    return (await response.json()).owedMentions.map(item => item.messageId).sort();
  };
  const proof169 = '841917f5eabd7bfb481b2037ae1920d723c2aed4069bbf075938ee12fd69ee72';
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,
    '@ruby For proof169, consider three different ways to arrange books in a small library.')`, [proof169, room, owner]);
  await routeHumanMessage(db, proof169);
  const pending = await phone.execute('sendRoomMessage', { roomId: room, text: '@ruby please answer this open human tag' }, owner);
  const foreign = await phone.execute('sendRoomMessage', { roomId: room, text: '@claude please answer' }, owner);
  const closed = await phone.execute('sendRoomMessage', { roomId: room, text: '@ruby this conversation will close' }, owner);
  const initial = [proof169, pending.messageId, closed.messageId].sort();
  assert.deepEqual(await read(), initial);
  // This is the exact missing link found in proof169's production answer:
  // request_id points at the tag, reply_to_message_id is NULL.
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,request_id)
    VALUES($1,$2,$3,'Three ways to organize books',$4)`, [id(), room, ruby, proof169]);
  await db.query(`SELECT beeline_end_agent_turn(id,generation_id,'cancelled','stop',NULL)
    FROM agent_commands WHERE agent_id=$1 AND source_message_id=$2`, [ruby, closed.messageId]);
  // Late delivery must not revive an already answered ledger entry.
  await recordMcpMention(db, ruby, room, proof169);
  const remaining = await read();
  assert.deepEqual(remaining, [pending.messageId]);
  assert.ok(!remaining.includes(foreign.messageId));
  await phone.execute('sendRoomReply', { roomId: room, parentMessageId: pending.messageId, text: 'Answered explicitly' }, ruby);
  assert.deepEqual(await read(), []);
  const open = await phone.execute('sendRoomMessage', { roomId: room, text: '@ruby another open tag' }, owner);
  assert.deepEqual(await read(), [open.messageId]);
  await db.query('UPDATE rooms SET archived_at=now() WHERE id=$1', [room]);
  assert.deepEqual(await read(), []);
  console.log('Reproduction owed-tags-1 PASS: built authenticated HTTP read drops request-linked answers, cancelled conversations, explicit replies and archived Rooms; preserves an open human tag and excludes another agent’s tag.');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await db.close();
}
