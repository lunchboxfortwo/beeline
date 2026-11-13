// Run with node --import tsx after building apps/server and shared packages.
// Isolated storage and a recording transport; never tags a production member.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { deliverMcpMemberWebhooks, setMcpMemberWebhook } from '../apps/server/dist/rooms-mcp-members.js';

const db = new PgliteDatabase();
const human = 'a'.repeat(64), agent = 'b'.repeat(64);
const workspace = randomUUID(), room = randomUUID();
const instruction = 'open its host conversation to read and reply, or finish delivery setup there for automatic wakes';
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle)
    VALUES($1,'human','Owner','owner'),($2,'agent','Muse proof','muse-proof')`, [human, agent]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agent, human]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Wake proof')", [workspace]);
  await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Wake proof')", [room, workspace]);
  for (const identity of [human, agent]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner')`, [workspace, room, identity]);
  await db.query(`INSERT INTO rooms_mcp_clients(id,name,redirects) VALUES('wake-proof','Proof','[]')`);
  await db.query(`INSERT INTO rooms_mcp_connections(client_id,identity_id,scope)
    VALUES('wake-proof',$1,'rooms:read rooms:write')`, [human]);
  await db.query(`INSERT INTO rooms_mcp_members(client_id,owner_id,member_id,model_label)
    VALUES('wake-proof',$1,$2,'Muse proof')`, [human, agent]);
  await db.query(`INSERT INTO rooms_mcp_delivery(member_id,generation,mechanism,host,surface,conversation,nonce_hash,probe)
    VALUES($1,$2,'local','Codex','CLI','unattached-thread','proof','{}')`, [agent, randomUUID()]);
  const phone = new PhoneService(db, 'http://proof');
  const first = await phone.execute('sendRoomMessage', { roomId: room, text: '@muse-proof hello' }, human);
  const view = await phone.readRoom(room, human);
  const notices = view.messages.filter(message => message.text.includes(instruction));
  assert.equal(notices.length, 1);
  assert.equal((await db.query('SELECT machine_id FROM agents WHERE agent_id=$1', [agent])).rows[0].machine_id, null);
  const firstNotice = notices[0].text;
  await phone.execute('sendRoomMessage', { roomId: room, text: '@muse-proof hello again' }, human);
  assert.equal((await phone.readRoom(room, human)).messages.filter(message => message.text.includes(instruction)).length, 1);
  const dm = await phone.execute('resolveDirectMessage', { workspaceId: workspace, participantId: agent }, human);
  await phone.execute('sendRoomMessage', { roomId: dm.id, text: 'Can you answer?' }, human);
  assert((await phone.readRoom(dm.id, human)).messages.some(message => message.text.includes(instruction)));
  assert.equal((await db.query('SELECT 1 FROM rooms_mcp_mentions WHERE member_id=$1 AND message_id=$2 AND cleared_at IS NULL', [agent, first.messageId])).rowCount, 1);

  await db.query('DELETE FROM rooms_mcp_delivery WHERE member_id=$1', [agent]);
  // Installing the host's callback reuses its existing member and ordinary tag route.
  await setMcpMemberWebhook(db, agent, { url: 'https://hooks.example/wake-proof' });
  const configured = await phone.execute('sendRoomMessage', { roomId: room, text: '@muse-proof configured wake' }, human);
  const received = [];
  const transport = async (url, init) => {
    received.push({ url, body: JSON.parse(init.body) });
    return new Response(null, { status: 204 });
  };
  assert.equal(await deliverMcpMemberWebhooks(db, transport), 1);
  assert.equal(await deliverMcpMemberWebhooks(db, transport), 0);
  assert.equal(received[0].body.messageId, configured.messageId);
  assert.equal(received[0].url, 'https://hooks.example/wake-proof');
  assert.equal((await phone.readRoom(room, human)).messages.filter(message => message.text.includes(instruction)).length, 1);
  console.log(JSON.stringify({ reproduction: 'muse-wake-1', notice: firstNotice,
    tagAndDmNotice: 'PASS', repeatNoticeDedup: 'PASS', configuredTagDeliveredOnce: received.length,
    liveRoomTagsSent: 0 }, null, 2));
} finally {
  await db.close();
}
