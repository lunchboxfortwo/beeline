import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { selectMcpOrder, createAgentCommand, dismissAgentCommandWakes, authorizeCommandOutput } from './agent-command.js';
import { PhoneService } from './phone-service.js';

const human = 'a'.repeat(64),
  agent = 'b'.repeat(64),
  workspace = randomUUID(),
  room = randomUUID();
const root = 'c'.repeat(64);
let db: PgliteDatabase;
beforeEach(async () => {
  db = await migratedDatabase();
  await db.query(
    `INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Worker')`,
    [human, agent],
  );
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [room, workspace]);
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner'),($1,$3,$4,'member')`,
    [workspace, human, room, agent],
  );
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Please check the work')`,
    [root, room, human],
  );
});
afterEach(() => db.close());
async function order() {
  return (await createAgentCommand(db, {
    roomId: room,
    agentId: agent,
    sourceMessageId: root,
    action: 'input',
    reason: 'order',
    privatePayload: { kind: 'order', authorId: human, fromRoomId: room, text: 'Check this work' },
  }))!;
}

it('selecting an MCP order preserves its durable pending item without a second ownership protocol',async()=>{
  const command=await order();
  const first=await db.transaction(tx=>selectMcpOrder(tx,agent,room,command.id));
  const second=await db.transaction(tx=>selectMcpOrder(tx,agent,room,command.id));
  expect(first?.id).toBe(command.id);expect(second?.id).toBe(command.id);
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[command.id])).rows).toEqual([{state:'pending'}]);
});
it('dismissing notifications leaves an unanswered order in its queue',async()=>{
  const command=await order();
  expect(await dismissAgentCommandWakes(db,room,agent,command.id)).toBe(0);
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[command.id])).rows).toEqual([{state:'pending'}]);
});
it('Stop removes the order from selection and refuses its late answer',async()=>{
  const command=await order();
  await new PhoneService(db,'http://test').execute('cancelAgentTurn',{roomId:room,agentId:agent,requestId:command.turn_request_id},human);
  expect(await selectMcpOrder(db,agent,room,command.id)).toBeUndefined();
  await expect(db.transaction(tx=>authorizeCommandOutput(tx,room,agent,command.turn_request_id))).rejects.toThrow('command turn cancelled');
});
