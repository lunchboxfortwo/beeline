// TAGS-1: isolated built phone socket proof; no production reads or writes.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { migratedDatabase } from '../../apps/server/src/test-support.ts';
import { createBeelineServer } from '../../apps/server/dist/server.js';
import { PhoneService } from '../../apps/server/dist/phone-service.js';
import { LiveHub } from '../../apps/server/dist/live.js';
import { tagSentence } from '../../apps/mobile/sources/ui/screens/tags/tag-card-model.ts';

const db = await migratedDatabase();
const a = 'a'.repeat(64), b = 'b'.repeat(64), r = 'c'.repeat(64), n = 'd'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const live = new LiveHub();
const phone = new PhoneService(db, 'http://localhost', undefined, undefined, live);
const server = createBeelineServer({ database: db, phone, live, daemon: {},
  auth: { authenticatePhone: async token => token === 'isolated-tags-proof' ? a : null }, mediaMaximumBytes: 1 });
let socket;
try {
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Ada','ada'),($2,'human','Bee','bee'),($3,'agent','Ruby','ruby'),($4,'agent','Other','other')`, [a,b,r,n]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2),($3,$4)', [r,a,n,b]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Tags proof')", [workspace]);
  await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Milo')", [room,workspace]);
  for (const who of [a,b,r,n]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`, [workspace,room,who]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,card,created_at) VALUES
    ('root',$1,$2,'needs-decision: Run the proof on your laptop?',jsonb_build_object('reportToId',$3::text),now()-interval '5 minutes')`, [room,r,a]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,reply_to_message_id,root_message_id,created_at) VALUES
    ('parent',$1,$2,'@ruby @other Can you check?','root','root',now()-interval '4 minutes'),
    ('reply',$1,$3,'@bee @other I asked Jellybean to check. This still needs you.','parent','root',now()-interval '3 minutes'),
    ('real',$1,$2,'@ada please confirm',NULL,NULL,now()-interval '2 minutes'),
    ('channel',$1,$2,'@channel please check',NULL,NULL,now()-interval '1 minute')`, [room,b,r]);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/phone/live`, ['bearer.isolated-tags-proof']);
  await once(socket, 'open');
  let sequence = 0;
  const read = (op, args) => new Promise((resolve, reject) => {
    const id = `tags-${++sequence}`;
    const listener = raw => {
      const value = JSON.parse(String(raw));
      if (value.t !== 'res' || value.id !== id) return;
      socket.off('message', listener);
      if (!value.ok) reject(new Error(JSON.stringify(value))); else resolve(value.result);
    };
    socket.on('message', listener);
    socket.send(JSON.stringify({t:'req',id,op,args}));
  });
  const { items } = await read('readNeedsYou', {workspaceId:workspace,markSeen:false});
  assert.deepEqual(items.map(item => item.messageId), ['root','real','channel']);
  assert.equal(tagSentence(items[0]).lead, 'Ruby needs your decision:');
  assert.ok(items.slice(1).every(item => tagSentence(item).lead.endsWith('tagged you:')));
  assert.equal((await read('countNeedsYou', {workspaceId:workspace})).count, items.length);
  await mkdir('proof/tags-1', {recursive:true});
  await writeFile('proof/tags-1/items.json', JSON.stringify({items},null,2)+'\n');
  console.log('Reproduction TAGS-1 PASS: built phone socket keeps the addressed decision with its decision label, excludes parent/reply, preserves viewer/channel tags and matching count.');
} finally {
  socket?.terminate();
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await db.close();
}
