import { startQueuedCommand } from './test-fixtures/queued-turn.test-support.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';
import { LiveHub } from './live.js';
import { AgentScheduleLoop } from './agent-schedules.js';
import { readAgentCommands } from './agent-command.js';

/**
 * Reproduction R5: a schedule fires for an agent that has an open,
 * self-assigned thread. The run belongs to the schedule's own place, and no
 * other thread's brief rides along.
 */

const H = 'a'.repeat(64),
  A = 'b'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111',
  R = '22222222-2222-4222-8222-222222222222';
const THREAD_BRIEF = 'CI investigation: today the health rotation is already complete.';
let db: PgliteDatabase, phone: PhoneService, daemon: DaemonService;
let cornerId: string;
let openingCommandId: string;

beforeAll(async () => {
  db = await migratedDatabase();
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Human','human'),($2,'agent','Jelly','jelly')`,
    [H, A],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [A, H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Places')`, [W]);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,repository_key,repository_remote,repository_resolution,
       repository_target_branch,github_installation_id)
     VALUES($1,$2,'Beeline','owner/widgets','https://github.com/owner/widgets.git','repository','main',77)`,
    [R, W],
  );
  await db.query(
    `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
     VALUES(77,$1,'42','owner','User','selected','active')`,
    [H],
  );
  await db.query(
    `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
     VALUES(101,77,'owner/widgets','main')`,
  );
  for (const who of [H, A])
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`,
      [W, who, R],
    );
  phone = new PhoneService(db, 'http://test');
  daemon = new DaemonService(db, new LiveHub());
  // The agent opens a thread for itself from the parent chat and leaves it open.
  await phone.execute(
    'sendRoomMessage',
    { roomId: R, messageId: randomBytes(32).toString('hex'), text: '@jelly look into CI' },
    H,
  );
  const command = (await daemon.execute('getAgentCommands', { roomId: R }, A)).commands.at(-1)!;
  openingCommandId = command.id;
  await startQueuedCommand(daemon, { roomId: R, commandId: command.id }, A);
  const created = await daemon.execute(
    'createCorner',
    {
      roomId: R, requestId: command.turnRequestId, name: 'ci-investigation', objective: 'Find the slow CI shard',
      repository: 'owner/widgets', targetBranch: 'main',
      brief: { spec: THREAD_BRIEF, approval: { sourceMessageId: command.sourceMessageId } },
    },
    A,
  );
  cornerId = created.cornerId;
}, 30_000);
afterAll(async () => db?.close());

async function fire(roomId: string, creator: string, prompt: string, requesterCommandId?: string) {
  const scheduleId = randomUUID();
  await db.query(
    `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,max_runs,next_run_at,requester_command_id)
     VALUES($1,$2,$3,$4,$5,'{"kind":"interval","everyMinutes":60}',$6,1,now()-interval '1 second',$7)`,
    [scheduleId, W, roomId, A, creator, prompt, requesterCommandId ?? null],
  );
  expect(await new AgentScheduleLoop(db).runOnce()).toBe(1);
  const all = (await readAgentCommands(db, A)).commands.filter(item => item.reason === 'schedule');
  const fired = all.filter(item => item.source.body.includes(prompt));
  expect(fired).toHaveLength(1);
  return { fired: fired[0]!, row: (await db.query<{ room_id: string; return_room_id: string; message: Record<string, unknown> }>(
    'SELECT room_id,return_room_id,message FROM agent_commands WHERE id=$1', [fired[0]!.id])).rows[0]! };
}

function carriesThreadBrief(value: unknown) {
  return JSON.stringify(value).includes(THREAD_BRIEF);
}

it.each([
  ['a person', () => H, () => undefined],
  ['the agent itself', () => A, () => undefined],
  ['the agent during the turn that opened the thread', () => A, () => openingCommandId],
])('Reproduction R5: a parent-chat schedule created by %s runs in the parent chat with no thread brief', async (_label, creator, requester) => {
  const prompt = `Run the codebase health check ${randomUUID()}`;
  const { fired, row } = await fire(R, creator(), prompt, requester());
  expect(fired.roomId).toBe(R);
  expect(fired.returnRoomId).toBe(R);
  expect(fired.parentRoomId).toBeUndefined();
  expect(fired.from.place).toBe(R);
  expect(row).toMatchObject({ room_id: R, return_room_id: R });
  expect(carriesThreadBrief(fired)).toBe(false);
  expect(carriesThreadBrief(row.message)).toBe(false);
  // The open thread gets nothing from this run.
  expect((await readAgentCommands(db, A, cornerId)).commands.filter(item => item.reason === 'schedule')).toEqual([]);
});

it('a schedule addressed to a thread still runs in that thread', async () => {
  const prompt = `Check the shard timings ${randomUUID()}`;
  const { fired } = await fire(cornerId, A, prompt);
  expect(fired.roomId).toBe(cornerId);
  expect(fired.returnRoomId).toBe(cornerId);
  expect(fired.parentRoomId).toBe(R);
  expect(carriesThreadBrief(fired)).toBe(true);
});
