import { beforeEach, describe, expect, it } from 'vitest';
import { agentOpenAsks, closeAgentAsk } from './agent-open-asks.js';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';

const PERSON = 'a'.repeat(64), AGENT = 'c'.repeat(64), OTHER = 'd'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111', ROOM = '22222222-2222-4222-8222-222222222222';

describe('an agent\'s open asks', () => {
  let db: PgliteDatabase;
  const ask = async (n: number, text = `needs-decision: question ${n}?`, author = AGENT) => {
    const id = n.toString(16).padStart(64, '0');
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,card,created_at)
      VALUES($1,$2,$3,$4,jsonb_build_object('reportToId',$5::text),now()-$6*interval '1 hour')`, [id, ROOM, author, text, PERSON, 100 - n]);
    return id;
  };

  beforeEach(async () => {
    db = await migratedDatabase();
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Ada','ada'),($2,'agent','Hoots','hoots'),($3,'agent','Other','other')`, [PERSON, AGENT, OTHER]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Launch')`, [ROOM, WORKSPACE]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member'),($1,$3,$4,'member'),($1,$3,$5,'member')`,
      [WORKSPACE, PERSON, ROOM, AGENT, OTHER]);
  });

  it('lists at most five, oldest first, then counts the rest; the version names the set, not its wording or age', async () => {
    const empty = await agentOpenAsks(db, AGENT, ROOM);
    expect(empty.text).toBe('');
    const ids = [];
    for (let n = 1; n <= 7; n += 1) ids.push(await ask(n));
    await ask(8, 'needs-decision: not mine?', OTHER);
    const listed = await agentOpenAsks(db, AGENT, ROOM);
    const lines = listed.text.split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[1]).toBe(`- [ask id: ${ids[0]}] 4d ago in Launch, to @ada: question 1?`);
    expect(lines[6]).toBe('2 more');
    expect(listed.text).not.toContain('not mine');
    await db.query(`UPDATE messages SET card=card||'{"ask":"Reworded?"}'::jsonb WHERE id=$1`, [ids[0]]);
    const later = await agentOpenAsks(db, AGENT, ROOM, Date.now() + 86_400_000);
    expect(later.version).toBe(listed.version);
    expect(later.text).toContain('5d ago in Launch, to @ada: Reworded?');
    expect(await closeAgentAsk(db, AGENT, { messageId: ids[0], reason: 'answered' })).toEqual({ closed: 1 });
    expect(await closeAgentAsk(db, AGENT, { messageId: ids[0], reason: 'answered' })).toEqual({ closed: 0 });
    const closed = await agentOpenAsks(db, AGENT, ROOM);
    expect(closed.version).not.toBe(listed.version);
    expect(closed.text.split('\n').at(-1)).toBe('1 more');
    expect(empty.version).not.toBe(closed.version);
  });
});
