import { describe, expect, it } from 'vitest';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { CommandRow } from './agent-command.js';
import { reportRecipient } from './message-route.js';
import { ensureSystemIdentity } from './system-line.js';
import { migratedDatabase } from './test-support.js';

const OWNER = 'a'.repeat(64);
const JELLYBEAN = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const CHAT = '22222222-2222-4222-8222-222222222222';
const TRIAGE = '33333333-3333-4333-8333-333333333333';

async function triageThread() {
  const db = await migratedDatabase();
  await ensureSystemIdentity(db);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Jellybean')`, [OWNER, JELLYBEAN]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'beeline')`, [CHAT, WORKSPACE, OWNER]);
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'issues-triage')`,
    [TRIAGE, WORKSPACE, CHAT, JELLYBEAN]);
  // Jellybean opened the triage thread from #beeline, so Jellybean in #beeline is its commander.
  await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,root_command_id,
      root_source_message_id,agent_depth,private_payload)
    VALUES('objective',$1,$2,'objective','input','corner_objective','objective','objective',0,$3)`,
    [TRIAGE, JELLYBEAN, JSON.stringify({ route: { from: { agent: JELLYBEAN, place: CHAT }, to: { agent: JELLYBEAN, place: TRIAGE } } })]);
  return db;
}

function wake(from: { agent: string; place: string }, replyAddress?: { agent: string; place: string }): CommandRow {
  return {
    id: 'wake', room_id: TRIAGE, agent_id: JELLYBEAN,
    message: { route: { from, to: { agent: JELLYBEAN, place: TRIAGE } }, ...(replyAddress ? { replyAddress } : {}) },
  } as unknown as CommandRow;
}

describe('reportRecipient', () => {
  it('sends the report of a Sentry wake to its recorded reply address, not the thread commander', async () => {
    const db = await triageThread();
    // The production shape: the System sent the wake, and it answers the digest's owner in the thread.
    const sentry = wake({ agent: SYSTEM_IDENTITY_ID, place: TRIAGE }, { agent: OWNER, place: TRIAGE });
    expect(await reportRecipient(db, sentry)).toEqual({ agent: OWNER, place: TRIAGE });
  });

  it('keeps reporting an agent-issued thread task to the thread commander', async () => {
    const db = await triageThread();
    const task = wake({ agent: JELLYBEAN, place: CHAT });
    expect(await reportRecipient(db, task)).toEqual({ agent: JELLYBEAN, place: CHAT });
  });

  it('keeps reporting a human tag in the thread to that human', async () => {
    const db = await triageThread();
    const tag = wake({ agent: OWNER, place: TRIAGE });
    expect(await reportRecipient(db, tag)).toEqual({ agent: OWNER, place: TRIAGE });
  });
});
