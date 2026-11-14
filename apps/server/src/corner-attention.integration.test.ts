import { startQueuedCommand } from './test-fixtures/queued-turn.test-support.js';
import { advanceCorner } from './corner-lifecycle.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { cornerReportWaiting } from './corner-state.js';
import { cornerWaitingReportSql } from './corner-waiting-report.js';

import { cornerIdleSql } from './corner-idle.js';
import { cornerOwedAnswerTimesSql } from './corner-owed.js';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { systemLine } from './system-line.js';
import { cornerOwedSchemaSql } from './corner-owed.js';
import { migrate, PostgresDatabase, type SqlDatabase } from './database.js';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { seedCornerOpening, PgliteDatabase, insertCornerFacts } from './test-support.js';
import { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { createAgentCommand, readAgentCommands } from './agent-command.js';
import {
  CORNER_ATTENTION_SCHEMA, CornerMachineEvents, refreshCornerAttention, runCornerAttention,
} from './corner-attention.js';

const WS = '11111111-1111-4111-8111-111111111111',
  ROOM = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const HUMAN_MEMBER = 'e'.repeat(64);
const HUMAN = 'a'.repeat(64),
  COMMANDER = 'b'.repeat(64),
  WORKER = 'c'.repeat(64),
  REVIEWER = 'd'.repeat(64);
let db: SqlDatabase, closeDatabase: () => Promise<void>, daemon: DaemonService, phone: PhoneService;
beforeAll(async () => {
  if (process.env.BEELINE_ATTENTION_TEST_POSTGRES_URL) {
    const url = process.env.BEELINE_ATTENTION_TEST_POSTGRES_URL;
    const schema = `attention_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pg = new PostgresDatabase('', 5, { pool: new Pool({ connectionString: url,
      options: `-c search_path=${schema},public` }), mode: 'migration' });
    db = pg;
    closeDatabase = async () => { await pg.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); };
  } else {
    const pg = new PgliteDatabase(); db = pg; closeDatabase = () => pg.close();
  }
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Commander','commander'),
    ($3,'agent','Worker','worker'),($4,'agent','Reviewer','reviewer')`,
    [HUMAN, COMMANDER, WORKER, REVIEWER],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$4),($2,$4),($3,$4)`, [
    COMMANDER,
    WORKER,
    REVIEWER,
    HUMAN,
  ]);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Room member','human-member')`, [HUMAN_MEMBER]);
  daemon = new DaemonService(db, new LiveHub());
  phone = new PhoneService(db, 'http://test');
}, 30_000);
afterAll(async () => closeDatabase());
beforeEach(async () => {
  await db.query('DELETE FROM workspaces');
  await db.query('DELETE FROM agent_connections');

  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Truthful states')`, [WS]);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,created_by,reviewer_agent_id) VALUES($1,$2,'Room',$3,$4)`,
    [ROOM, WS, HUMAN, REVIEWER],
  );
  for (const identity of [HUMAN, COMMANDER, WORKER, REVIEWER, HUMAN_MEMBER])
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`,
      [WS, identity, ROOM],
    );
  await db.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Corner',$4)`,
    [C, WS, ROOM, COMMANDER],
  );
  await insertCornerFacts(db, { cornerId: C, ownerAgentId: WORKER, commissionedBy: HUMAN, workerAgentId: WORKER });
  await createAgentCommand(db, {
    id: 'opening-order',
    roomId: C,
    agentId: WORKER,
    sourceMessageId: null,
    reason: 'order',
    privatePayload: { kind: 'order', text: 'Do the work', authorId: COMMANDER, fromRoomId: ROOM },
  });
  await db.query(`UPDATE agent_commands SET state='complete' WHERE id='opening-order'`);
  await db.query(`DELETE FROM agent_turns WHERE room_id=$1`,[C]);
  await db.query("UPDATE rooms SET created_at=now()-interval '1 day' WHERE id=$1", [C]);
});
const state = async () => {
  await refreshCornerAttention(db, C); // Drain the committed event in this isolated service fixture.
  return (await daemon.execute('getCornerRestoreState', { cornerId: C }, WORKER)).state;
};
const wake = async (agentId = WORKER, id = 'new-work') =>
  createAgentCommand(db, {
    id,
    roomId: C,
    agentId,
    sourceMessageId: null,
    reason: 'order',
    privatePayload: { kind: 'order', text: 'Continue', authorId: agentId === COMMANDER ? HUMAN : COMMANDER, fromRoomId: ROOM },
  });
const post = async (id: string, text: string, author = WORKER, age = '0 hours') =>
  db.query(
    `INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
  VALUES($1,$2,$3,$4,'message',now()-$5::interval)`,
    [id, C, author, text, age],
  );
// The idle alert now wakes its opening commander inside the corner whenever
// the commander has effective access (inherited parent-roster access counts).
const commanderFlags = async () => (await readAgentCommands(db, COMMANDER, C)).commands;

it('MODEL-UNKNOWN: a model owner end remains terminal while a new explicit command can run', async () => {
  const command=(await wake())!;
  await startQueuedCommand(daemon, { roomId:C, commandId:command.id }, WORKER);
  expect((await db.query<{worker_active:boolean}>(cornerIdleSql('$1'),[C])).rows[0]?.worker_active).toBe(true);
  await daemon.execute('postRoomMessage',{roomId:C,requestId:command.turn_request_id,text:'Worker stopped while answering this: model result unknown'},WORKER);
  const idle=(await db.query<{worker_active:boolean;suppressed:boolean}>(cornerIdleSql('$1'),[C])).rows[0]!;
  expect(idle.worker_active).toBe(false);
  expect(idle.suppressed).toBe(false);
  await post('explicit-after-unknown','Do this new task',HUMAN);
  const next=(await createAgentCommand(db,{id:'explicit-after-unknown-command',roomId:C,agentId:WORKER,
    sourceMessageId:'explicit-after-unknown',reason:'human_tag'}))!;
  expect((await readAgentCommands(db, WORKER, C)).commands.map(item=>item.id)).toContain(next.id);
  await startQueuedCommand(daemon, { roomId:C, commandId:next.id }, WORKER);
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[command.id])).rows)
    .toEqual([{state:'complete'}]);
});

it('a pre-claim failure cannot end queued work; its owner can report a plain failure after claim', async () => {
  const command=(await wake())!;
  await daemon.execute('postAgentTurnReceipt',{roomId:C,requestId:command.turn_request_id,status:'failed',reason:'git fetch failed: cannot lock ref'},WORKER);
  expect((await readAgentCommands(db,WORKER,C)).commands.map(item=>item.id)).toContain(command.id);
  await startQueuedCommand(daemon,{roomId:C,commandId:command.id},WORKER);
  await daemon.execute('postRoomMessage',{roomId:C,requestId:command.turn_request_id,text:'failed: git fetch failed: cannot lock ref'},WORKER);
  expect(await state()).toBe('idle');
  const failures=(await readAgentCommands(db, COMMANDER, C)).commands.filter(item=>item.reason==='report'&&item.source.body.startsWith('failed:'));
  expect(failures).toHaveLength(1);
  expect(failures[0]!.source.body).toContain('cannot lock ref');
});

async function turn(agent = WORKER) {
  let command=agent===COMMANDER?undefined:(await readAgentCommands(db, agent, C)).commands[0];
  if(!command) {
    const queued=(await wake(agent,randomUUID()))!;
    command=(await readAgentCommands(db, agent, C)).commands.find(item=>item.id===queued.id)!;
  }
  await startQueuedCommand(daemon, { roomId:C, commandId:command.id }, agent);
}
async function end(agent = WORKER, age = 0) {
  await db.query(`SELECT beeline_finish_agent_command(id,'complete',NULL,NULL) FROM agent_commands
    WHERE room_id=$1 AND agent_id=$2 AND state='pending'`,[C,agent]);
  await db.query(`UPDATE agent_turns SET ended_at=clock_timestamp()-make_interval(secs=>$2)
    WHERE room_id=$1 AND status<>'working' AND agent_id=$3`,[C,age,agent]);
}
/** Attention-only check facts have no current PR target; dispatch coverage uses explicit PR facts. */
async function ci(checks: string) {
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
    C,
    JSON.stringify({
      lifecycle: 'in-review',
      checks,
      checksSummary: {
        status: checks,
        total: 1,
        updatedAt: Date.now() / 1000,
        checks: [
          {
            name: 'tests',
            status: checks === 'pending' ? 'pending' : 'failed',
            url: 'https://github.com/o/r/actions/runs/1',
          },
        ],
        failing: [],
      },
    }),
  ]);
}
async function unreportedHead() {
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
    C,
    JSON.stringify({
      lifecycle: 'in-review',
      checks: 'unknown',
      pr: { number: 1, url: 'https://github.com/o/r/pull/1', headSha: 'head', title: 'Fix', targetBranch: 'main' },
      checksSummary: { status: 'unknown', total: 0, failing: [], checks: [], updatedAt: Date.now() / 1000 },
    }),
  ]);
}
it('Reproduction CORNER-STATE: the Room list and corner inspection agree that CI is Review without human attention', async () => {
  await turn();
  expect(await state()).toBe('working');
  await end(WORKER, 10);
  expect(await state()).toBe('idle');
  await end(WORKER, 40);
  expect(await state()).toBe('idle');
  await turn(REVIEWER);
  expect(await state()).toBe('review');
  await end(REVIEWER, 40);
  await ci('pending');
  expect(await state()).toBe('review');
  const row = (await phone.readCorners(ROOM, HUMAN))!.corners[0]!;
  expect(row).toMatchObject({
    state: 'review',
  });
  expect(
    (await phone.readChats(WS, HUMAN))!.chats.find((row) => row.room.id === ROOM)?.openCorners?.[0]
      ?.state,
  ).toBe('review');
  expect(row.blocker).toBeUndefined();
  const deck = await phone.liveChatCornerStatus(ROOM, HUMAN);
  expect(deck).toMatchObject({ waitingCornerCount: 0, agentState: null });
  expect(deck!.openCorners[0]).not.toHaveProperty('attention', true);
  await ci('failing');
  expect(await state()).toBe('idle');
  console.info('Demonstrated CORNER-STATE: live work is Working, pending CI is Review, failing checks alone are Idle');
});
it.each(['pending', 'unreported'] as const)(
  'Reproduction R1: a lone human merge hold shows review during %s checks and waits once they pass',
  async (checks) => {
    if (checks === 'pending') await ci('pending');
    else await unreportedHead();
    await phone.execute('setCornerHold', { cornerId: C }, HUMAN);
    const shown = async () => ({
      state: await state(),
      row: (await phone.readCorners(ROOM, HUMAN))!.corners[0]!,
      chat: (await phone.readChats(WS, HUMAN))!.chats.find((chat) => chat.room.id === ROOM)?.openCorners?.[0],
      deck: (await phone.liveChatCornerStatus(ROOM, HUMAN))!,
    });
    const during = await shown();
    expect(during.state).toBe('review');
    expect(during.row).toMatchObject({ state: 'review' });
    expect(during.row.blocker).toBeUndefined();
    expect(during.chat?.state).toBe('review');
    expect(during.deck).toMatchObject({ waitingCornerCount: 0 });
    await ci('passing');
    const after = await shown();
    expect(after.state).toBe('waiting');
    expect(after.row).toMatchObject({ state: 'waiting', blocker: { kind: 'merge-hold', personId: HUMAN } });
    expect(after.chat?.state).toBe('waiting');
    expect(after.deck).toMatchObject({ waitingCornerCount: 1 });
    console.info(
      `Demonstrated Reproduction R1: a held corner reads ${during.row.state} during ${checks} checks and ${after.row.state} on the hold once they pass`,
    );
  },
);

it('two server instances observe one immediate idle notice without a deadline', async () => {
  await turn();await end();
  vi.useFakeTimers();
  const live = new LiveHub(), errors: unknown[] = [];
  const a = new CornerMachineEvents(db,live,error=>errors.push(error));
  const b = new CornerMachineEvents(db,live,error=>errors.push(error));
  try {
    await Promise.all([a.start(),b.start()]);
    expect(await commanderFlags()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(errors).toEqual([]);
  } finally {await a.stop();await b.stop();vi.useRealTimers();}
});

it('Reproduction CORNER-REVIEW-ROLE: a dispatched reviewer stays Review after Room settings change until its turn ends', async () => {
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
    [C,JSON.stringify({lifecycle:'in-review',checks:'passing',pr:{number:1,headSha:'review-head'}})]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,system_event)
    VALUES('review-source',$1,$2,'Review requested','system',$3::jsonb)`,
    [C,COMMANDER,JSON.stringify({kind:'check-passed',object:{headSha:'review-head'}})]);
  const dispatch=await createAgentCommand(db,{id:'review-dispatch',roomId:C,agentId:REVIEWER,
    sourceMessageId:'review-source',reason:'corner_review_dispatch'});
  expect(dispatch).toBeTruthy();
  await db.query(`UPDATE agent_commands SET review_context=$2::jsonb WHERE id=$1`, [dispatch!.id,
    JSON.stringify({cornerId:C,headSha:'review-head',pullRequest:1,briefRevision:0})]);
  const serviceStates=async()=>[await state(),(await phone.readCorners(ROOM,HUMAN))!.corners[0]!.state];
  // A queued reviewer keeps the corner in review during its pickup window.
  expect(await serviceStates()).toEqual(['review','review']);
  await startQueuedCommand(daemon, { roomId:C, commandId:dispatch!.id }, REVIEWER);
  expect(await serviceStates()).toEqual(['review','review']);
  await db.query(`UPDATE rooms SET reviewer_agent_id=NULL WHERE id=$1`,[ROOM]);
  expect(await serviceStates()).toEqual(['review','review']);
  await runCornerAttention(db);
  // The review gap notice now reaches the commander in this corner; no idle alert joins it.
  expect((await commanderFlags()).filter(c=>c.source.body.includes(' is idle.'))).toHaveLength(0);
  await end(REVIEWER,40);
  // A terminal review without a verdict returns ownership to the implementer.
  expect(await serviceStates()).toEqual(['working','working']);
  console.info('Demonstrated CORNER-REVIEW-ROLE: getCornerRestoreState and PhoneService.readCorners preserve Review across reviewer settings changes, then leave Review on turn completion');
});

// The production attention entrypoint and command inbox are the stand-in for a
// background production alert; no live corner is deliberately stalled here.
it('Reproduction IDLE-1: incidental orders cannot redirect an idle alert from its opening commander', async () => {
  await createAgentCommand(db, {
    id: 'incidental-order', roomId: C, agentId: WORKER, sourceMessageId: null, reason: 'order',
    privatePayload: { kind: 'order', text: 'Check something', authorId: REVIEWER, fromRoomId: ROOM },
  });
  await db.query("UPDATE agent_commands SET state='complete' WHERE id='incidental-order'");
  await db.query('DELETE FROM agent_turns WHERE room_id=$1', [C]);
  await runCornerAttention(db);
  expect(await commanderFlags()).toHaveLength(1);
  expect((await readAgentCommands(db, REVIEWER, ROOM)).commands).toHaveLength(0);
  expect((await readAgentCommands(db, WORKER, C)).commands).toHaveLength(0);
});

it.each(['failed', 'complete'])('Reproduction IDLE-STORM: commander %s does not reopen its own idle episode', async (status) => {
  await ci('passing');
  await refreshCornerAttention(db, C);
  expect(await commanderFlags()).toHaveLength(1);
  await turn(COMMANDER);
  await refreshCornerAttention(db, C);
  await db.query(`UPDATE agent_turns SET status=$2 WHERE room_id=$1 AND agent_id=$3`, [C,status,COMMANDER]);
  await refreshCornerAttention(db, C);
  expect((await db.query(`SELECT id FROM agent_commands WHERE reason='report'`)).rows).toHaveLength(1);
});

// Isolated service reads stand in for the production phone and agent surfaces.
it('Reproduction HEADER-STATE-1: reviewer on failing checks displays review', async () => {
  await ci('failing');
  await turn(REVIEWER);
  expect(await state()).toBe('review');
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]!.state).toBe('review');
});

it('Reproduction HEADER-STATE-3: simultaneous implementer and reviewer display working', async () => {
  await turn(WORKER);
  await turn(REVIEWER);
  expect(await state()).toBe('working');
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]!.state).toBe('working');
});
it('Reproduction HEADER-STATE-5: a queued reviewer stays review until that command is done', async () => {
  await wake(REVIEWER, 'queued-review');
  expect(await state()).toBe('review');
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]!.state).toBe('review');
  await db.query("UPDATE agent_turns SET created_at=now()-interval '31 seconds' WHERE room_id=$1", [C]);
  await db.query(`DELETE FROM agent_turns WHERE room_id=$1`, [C]);
  expect(await state()).toBe('review');
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]).toMatchObject({ state: 'review' });
  await db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE id='queued-review'`);
  expect(await state()).toBe('idle');
});
it('Reproduction R1: a worker order waiting on an offline helper stays working', async () => {
  await wake(WORKER, 'queued-implementer');
  await db.query("UPDATE agent_turns SET created_at=now()-interval '31 seconds' WHERE room_id=$1", [C]);
  await db.query(`DELETE FROM agent_turns WHERE room_id=$1`, [C]);
  const restore = await daemon.execute('getCornerRestoreState', { cornerId: C }, WORKER);
  expect(restore).toMatchObject({ state: 'working', activity: 'running' });
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]).toMatchObject({ state: 'working' });
  expect(
    (await phone.readChats(WS, HUMAN))!.chats.find((chat) => chat.room.id === ROOM)?.openCorners?.[0],
  ).toMatchObject({ state: 'working' });
  await db.query(`INSERT INTO live_server_instances(instance_id) VALUES('r1-online') ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id)
    VALUES($1,1,'r1-online','r1-online')`, [WORKER]);
  expect(await daemon.execute('getCornerRestoreState', { cornerId: C }, WORKER)).toMatchObject({
    state: 'working', activity: 'running',
  });
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]).toMatchObject({ state: 'working' });
  const behind = '44444444-4444-4444-8444-444444444444';
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'codex-dot-connect',$3)`,
    [behind, WS, HUMAN],
  );
  await db.query(
    `INSERT INTO agent_turns(room_id,request_id,agent_id,status)
     VALUES($1,$2,$3,'working')`,
    [behind, 'f'.repeat(64), WORKER],
  );
  expect(await daemon.execute('getCornerRestoreState', { cornerId: C }, WORKER)).toMatchObject({
    state: 'working', activity: 'running',
  });
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]).toMatchObject({
    state: 'working',
  });
  expect(
    (await phone.readChats(WS, HUMAN))!.chats.find((chat) => chat.room.id === ROOM)?.openCorners?.[0],
  ).toMatchObject({ state: 'working' });
  await db.query(`DELETE FROM agent_turns WHERE room_id=$1`, [behind]);
  await db.query(
    `UPDATE agent_commands SET created_at=now()-interval '1 day' WHERE id='queued-implementer'`,
  );
  expect(await daemon.execute('getCornerRestoreState', { cornerId: C }, WORKER)).toMatchObject({
    state: 'working', activity: 'running',
  });
  await db.query(`UPDATE agent_commands SET state='pending' WHERE id='queued-implementer'`);

  expect(await state()).toBe('working');
  await db.query("UPDATE agent_commands SET state='complete',completed_at=now() WHERE id='queued-implementer'");
  expect(await state()).toBe('idle');
});

it('IDLE-DERIVED: a human-directed report resolves from the message log once answered', async () => {
  await db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{authorId}',to_jsonb($1::text)) WHERE room_id=$2 AND reason='corner_objective'`,[HUMAN,C]);
  const { reportToCommander } = await import('./commander.js');
  const report = await reportToCommander(db,C,WORKER,'blocked: Which scope?');
  expect(await cornerReportWaiting(db, C)).toBe(true);
  const at = new Date(Date.now()-60_000);
  await db.query('UPDATE messages SET created_at=$2 WHERE id=$1',[report.id,new Date(at.getTime()-60_000)]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,created_at,reply_to_message_id)
    VALUES('human-report-answer',$1,$2,'Narrow scope','message',$3,$4)`,[ROOM,HUMAN,at,report.id]);
  expect(await cornerReportWaiting(db, C)).toBe(false);
  const row = (await db.query<{idle_since:string}>(cornerIdleSql('$1'),[C])).rows[0]!;
  expect(Number(row.idle_since)).toBeCloseTo(at.getTime()/1000,3);
});

it('IDLE-DERIVED: an owed item in the return Room resolves at its first answering message', async () => {
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card,created_at)
    VALUES('return-question',$1,$2,'@owner Which scope?','message',jsonb_build_object('sourceRoomId',$3::text),now()-interval '2 minutes')`,[ROOM,WORKER,C]);
  expect((await db.query('SELECT 1 FROM corner_owed WHERE corner_id=$1',[C])).rows).toHaveLength(1);
  const at = new Date(Date.now()-60_000);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
    VALUES('return-answer',$1,$2,'The narrow scope','message',$3)`,[ROOM,HUMAN,at]);
  expect((await db.query('SELECT 1 FROM corner_owed WHERE corner_id=$1',[C])).rows).toEqual([]);
  const idleSince = async () => (await db.query<{idle_since:string}>(cornerIdleSql('$1'),[C])).rows[0]!.idle_since;
  expect(Number(await idleSince())).toBeCloseTo(at.getTime()/1000,3);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation)
    VALUES('later-return-answer',$1,$2,'More context','message')`,[ROOM,HUMAN]);
  expect(Number(await idleSince())).toBeCloseTo(at.getTime()/1000,3);
  await db.query(`UPDATE messages SET deleted_at=now() WHERE id IN ('return-answer','later-return-answer')`);
  expect((await db.query(cornerOwedAnswerTimesSql('$1'),[C])).rows).toEqual([]);
});

it('IDLE-SCOPE: another corner’s answered report never changes this corner’s idle episode', async () => {
  const other = '44444444-4444-4444-8444-444444444444';
  const idleSince = async () => (await db.query<{ idle_since: string }>(cornerIdleSql('$1'), [C])).rows[0]!.idle_since;
  const before = await idleSince();
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by)
    VALUES($1,$2,$3,'Unrelated corner',$4)`, [other, WS, ROOM, COMMANDER]);
  await insertCornerFacts(db, { cornerId: other, ownerAgentId: WORKER, workerAgentId: WORKER });
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,card,created_at)
    VALUES($1,$2,$3,'blocked: Choose a scope.',
      jsonb_build_object('sourceRoomId',$4::text,'reportToId',$5::text,'waitingAnswered',true),now()-interval '2 minutes')`,
    ['e'.repeat(64), ROOM, WORKER, other, COMMANDER]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
    VALUES($1,$2,$3,'Proceed with that scope.',now()-interval '1 minute')`, ['f'.repeat(64), ROOM, COMMANDER]);
  expect(await idleSince()).toBe(before);
  await db.query('UPDATE rooms SET archived_at=now() WHERE id=$1', [other]);
  expect((await db.query(cornerIdleSql('$1'), [other])).rows).toEqual([]);
  expect(await idleSince()).toBe(before);
});

it.each(['55P03', '08006'])('Reproduction SENTRY-4B: refresh never replays a failed transaction (%s)', async code => {
  const failure = Object.assign(new Error('refresh failed'), { code });
  const observe = vi.spyOn(db, 'transaction').mockRejectedValue(failure);
  try {
    await expect(refreshCornerAttention(db, C)).rejects.toBe(failure);
    expect(observe).toHaveBeenCalledTimes(1);
  } finally { observe.mockRestore(); }
});

it('Reproduction SENTRY-4B: overlapping events collapse into one committed-event follow-up', async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const transaction = db.transaction.bind(db);
  const observe = vi.spyOn(db, 'transaction').mockImplementation(async work => {
    entered(); await gate; return transaction(work);
  });
  const live = new LiveHub(), publish = vi.spyOn(live, 'publish');
  const runtime = new CornerMachineEvents(db, live, () => {});
  try {
    const first = runtime.refresh(C); await held;
    const second = runtime.refresh(C);
    const duplicate = runtime.refresh(C);
    release(); await Promise.all([first, second, duplicate]);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(2);
    expect((await phone.readCorners(ROOM, HUMAN))!.corners.find(corner => corner.corner.id === C)?.state).toBe('idle');
  } finally { release(); observe.mockRestore(); await runtime.stop(); }
});


it('Reproduction SENTRY-4B: a committed command during refresh completion reaches the phone badge', async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const transaction = db.transaction.bind(db);
  let firstTransaction = true;
  const observe = vi.spyOn(db, 'transaction').mockImplementation(async work => {
    const result = await transaction(work);
    if (firstTransaction) {
      firstTransaction = false;
      entered(); await gate;
    }
    return result;
  });
  const runtime = new CornerMachineEvents(db, new LiveHub(), () => {});
  try {
    const first = runtime.refresh(C); await held;
    await wake(WORKER, 'committed-during-refresh-completion');
    const second = runtime.refresh(C);
    release(); await Promise.all([first, second]);
    expect((await phone.readCorners(ROOM, HUMAN))!.corners.find(corner => corner.corner.id === C)?.state).toBe('working');
  } finally { release(); observe.mockRestore(); await runtime.stop(); }
});
