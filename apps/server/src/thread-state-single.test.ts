import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertCornerFacts, migratedDatabase, type PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { HelperDaemonService } from './test-fixtures/helper-daemon.js';
import { LiveHub } from './live.js';
import { foldThreadWorkStates, readWorkBoard, readWorkThread, updateWorkItem } from './work-board.js';
import { transitionCorner } from './corner-machine.js';

// One thread state machine: corner_facts.machine. These tests plant every retired second
// source (a stored Work-board state on the thread's own row) and require each writer and
// reader to keep or report only the machine's state.
const person = 'a'.repeat(64),
  agent = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const chat = '22222222-2222-4222-8222-222222222222';
const thread = '33333333-3333-4333-8333-333333333333';
let db: PgliteDatabase;
let phone: PhoneService;
let daemon: HelperDaemonService;

beforeEach(async () => {
  db = await migratedDatabase();
  phone = new PhoneService(db, 'https://server.example');
  daemon = new HelperDaemonService(db, new LiveHub());
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Ada','ada'),($2,'agent','Jellybean','jellybean')`,
    [person, agent],
  );
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agent, person]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Crew')", [workspace]);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$3,NULL,'beeline',$4),($2,$3,$1,'latency-capture',$4)`,
    [chat, thread, workspace, agent],
  );
  for (const identity of [person, agent])
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'member')`,
      [workspace, chat, identity],
    );
  await insertCornerFacts(db, { cornerId: thread, workerAgentId: agent });
  await db.query(`UPDATE corner_facts SET machine='{"state":"idle"}'::jsonb WHERE corner_id=$1`, [thread]);
});
afterEach(async () => {
  await db.close();
});

const storedState = async (id: string) =>
  (await db.query<{ state: string | null }>('SELECT state FROM work_items WHERE id=$1', [id])).rows[0]?.state;
/** A row an older server stored before the fold; the store trigger refuses new ones. */
const plantLegacyState = async (state: string) => {
  await db.query('ALTER TABLE work_items DISABLE TRIGGER thread_work_state');
  await db.query(
    `INSERT INTO work_items(id,room_id,state,opened_by) VALUES($1,$4,$2,$3)
     ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state`,
    [thread, state, agent, thread],
  );
  await db.query('ALTER TABLE work_items ENABLE TRIGGER thread_work_state');
};
/** Every reader of a thread's state, as the phone, Tasks and the thread header see it. */
const readers = async () => {
  const listed = (await phone.readChats(workspace, person))?.chats
    .find((entry) => entry.room.id === chat)?.openCorners?.find((corner) => corner.id === thread);
  const page = (await phone.readCorners(chat, person))?.corners.find((item) => item.corner.id === thread);
  const board = (await readWorkBoard(db, workspace, person)).items.find((item) => item.id === thread);
  const header = (await readWorkThread(db, thread, person))[0];
  return {
    list: listed && { state: listed.state, reason: listed.reason },
    page: page && { state: page.state, reason: page.reason },
    board: board && { state: board.state, idle: board.idle ?? false },
    header: header && { state: header.state, idle: header.idle ?? false },
  };
};

describe('one thread state: the corner machine', () => {
  it('the store clears a state written to a thread’s own task row by any writer, and keeps other tasks’ state', async () => {
    await db.query(`INSERT INTO work_items(id,room_id,state,opened_by) VALUES($1,$3,'done',$2)`, [thread, agent, thread]);
    expect(await storedState(thread)).toBeNull();
    await db.query(`UPDATE work_items SET state='backlog',completed_at=now() WHERE id=$1`, [thread]);
    expect(await storedState(thread)).toBeNull();
    await updateWorkItem(db, { roomId: thread, title: 'Capture latency', assigneeId: agent }, agent);
    expect(await storedState(thread)).toBeNull();
    await updateWorkItem(db, { id: 'task', roomId: chat, state: 'done' }, agent);
    expect(await storedState('task')).toBe('done');
  });

  it('a planted stored Done or Backlog cannot move any reader off the machine', async () => {
    const machineIdle = {
      list: { state: 'idle', reason: undefined },
      page: { state: 'idle', reason: undefined },
      board: { state: 'in-progress', idle: true },
      header: { state: 'in-progress', idle: true },
    };
    // latency-capture-investigation: Done stored while the machine stayed idle.
    for (const legacy of ['done', 'backlog']) {
      await plantLegacyState(legacy);
      expect(await storedState(thread)).toBe(legacy);
      expect(await readers()).toEqual(machineIdle);
    }
    await db.query(`UPDATE corner_facts SET machine='{"state":"review","phase":"reviewer"}'::jsonb WHERE corner_id=$1`, [thread]);
    expect(await readers()).toMatchObject({
      list: { state: 'review' }, page: { state: 'review' },
      board: { state: 'in-review', idle: false }, header: { state: 'in-review', idle: false },
    });
  });

  it('Backlog is a machine input: idle with reason backlog everywhere, without an idle notice', async () => {
    await updateWorkItem(db, { roomId: thread, state: 'backlog' }, person);
    expect(await storedState(thread)).toBeNull();
    expect((await db.query('SELECT machine FROM corner_facts WHERE corner_id=$1', [thread])).rows[0])
      .toMatchObject({ machine: { state: 'idle', reason: 'backlog', backlog: true } });
    expect(await readers()).toEqual({
      list: { state: 'idle', reason: 'backlog' },
      page: { state: 'idle', reason: 'backlog' },
      board: { state: 'backlog', idle: false },
      header: { state: 'backlog', idle: false },
    });
    // The machine sends no idle notice for a Backlog thread; it does for an ordinary idle one.
    const facts = { archived: false, turnRunning: false, idleEligible: true, idleSince: '1' };
    expect(transitionCorner({ state: 'idle', backlog: true }, { facts, event: { kind: 'reconcile' } }).notifications).toEqual([]);
    expect(transitionCorner({ state: 'idle' }, { facts, event: { kind: 'reconcile' } }).notifications)
      .toEqual([{ kind: 'idle', key: 'idle:1' }]);
    // Work still runs a Backlog thread; leaving Backlog resumes the assigned implementer.
    expect(transitionCorner({ state: 'idle', backlog: true }, { facts: { ...facts, turnRunning: true }, event: { kind: 'reconcile' } }).state)
      .toMatchObject({ state: 'working', backlog: true });
    await updateWorkItem(db, { roomId: thread, state: 'in-progress' }, person);
    expect(await readers()).toMatchObject({ list: { state: 'working', reason: undefined }, board: { state: 'in-progress', idle: false } });
    expect((await db.query(`SELECT id FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND state='pending'`, [thread, agent])).rowCount).toBe(1);
    // An unassigned parked thread leaves Backlog to plain idle without queueing work.
    await updateWorkItem(db, { roomId: thread, state: 'backlog' }, person);
    await db.query('UPDATE corner_facts SET implementer_agent_id=NULL WHERE corner_id=$1', [thread]);
    await updateWorkItem(db, { roomId: thread, assigneeId: null }, person);
    await updateWorkItem(db, { roomId: thread, state: 'in-progress' }, person);
    expect(await readers()).toMatchObject({ list: { state: 'idle', reason: undefined }, board: { state: 'in-progress', idle: true } });
    expect((await db.query(`SELECT id FROM agent_commands WHERE room_id=$1 AND state='pending'`, [thread])).rowCount).toBe(0);
  });

  it('Done on a thread is exactly its existing close, through each caller’s close', async () => {
    const close = vi.fn(async () => undefined);
    await updateWorkItem(db, { roomId: thread, state: 'done' }, person, person, close);
    expect(close).toHaveBeenCalledOnce();
    expect(await storedState(thread)).toBeNull();
    await expect(updateWorkItem(db, { roomId: thread, state: 'done' }, person)).rejects.toThrow('marked done only by its close');
    // The agent's update_work runs the agent close: refused on a locked thread, archives otherwise.
    await db.query('UPDATE corner_facts SET locked=true WHERE corner_id=$1', [thread]);
    await expect(daemon.execute('updateWorkItem', { targetRoomId: thread, state: 'done' }, agent)).rejects.toThrow(/locked/);
    expect((await db.query('SELECT archived_at FROM rooms WHERE id=$1', [thread])).rows[0]?.archived_at).toBeNull();
    await db.query('UPDATE corner_facts SET locked=false WHERE corner_id=$1', [thread]);
    await daemon.execute('updateWorkItem', { targetRoomId: thread, state: 'done' }, agent);
    expect((await db.query('SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1', [thread])).rows[0]).toEqual({ archived: true });
    // Closed: it leaves the open chat and corner lists, and Tasks and the header read Done.
    expect(await readers()).toEqual({ list: undefined, page: undefined,
      board: { state: 'done', idle: false }, header: { state: 'done', idle: false } });
  });

  it('the fold preserves open stored-Done threads, makes stored Backlog a machine input, and clears every thread row', async () => {
    const parked = '55555555-5555-4555-8555-555555555555',
      standing = '66666666-6666-4666-8666-666666666666';
    for (const [id, name] of [[parked, 'parked'], [standing, 'standing']] as const) {
      await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,$4,$5)`, [id, workspace, chat, name, agent]);
      await insertCornerFacts(db, { cornerId: id, workerAgentId: agent, locked: id === standing });
    }
    await db.query('ALTER TABLE work_items DISABLE TRIGGER thread_work_state');
    await db.query(
      `INSERT INTO work_items(id,room_id,state,opened_by) VALUES($1,$6,'done',$4),($2,$7,'backlog',$4),($3,$8,'done',$4),('task',$5,'done',$4)`,
      [thread, parked, standing, agent, chat, thread, parked, standing],
    );
    await db.query('ALTER TABLE work_items ENABLE TRIGGER thread_work_state');
    await foldThreadWorkStates(db);
    const rooms = (await db.query<{ id: string; archived: boolean; machine: unknown }>(
      `SELECT r.id,r.archived_at IS NOT NULL archived,f.machine FROM rooms r JOIN corner_facts f ON f.corner_id=r.id WHERE r.id=ANY($1::uuid[])`,
      [[thread, parked, standing]])).rows;
    expect(Object.fromEntries(rooms.map((room) => [room.id, room.archived]))).toEqual({ [thread]: false, [parked]: false, [standing]: false });
    expect(rooms.find((room) => room.id === thread)?.machine).toEqual({ state: 'idle' });
    expect(rooms.find((room) => room.id === parked)?.machine).toMatchObject({ state: 'idle', reason: 'backlog' });
    expect((await db.query(`SELECT id,state FROM work_items ORDER BY id`)).rows).toEqual(
      [{ id: thread, state: null }, { id: parked, state: null }, { id: standing, state: null }, { id: 'task', state: 'done' }]
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});
