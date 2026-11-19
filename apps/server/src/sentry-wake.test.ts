import { createHmac, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { migrate, PostgresDatabase, type ClosableDatabase } from './database.js';
import { migratedDatabase } from './test-support.js';
import { createBeelineServer, type ServerOptions } from './server.js';
import { LiveHub } from './live.js';
import { flushSentryWakes, sentryWakeAgentFromEnv } from './sentry-wake.js';
import { createAgentCommand, type CommandRow } from './agent-command.js';
import { seedSentryDigestAuthority } from './migrations/sentry-digest-authority.js';
import { DaemonService } from './daemon-service.js';
import { startQueuedTurn } from './test-fixtures/queued-turn.test-support.js';
import { stubMemoryEmbeddings } from './test-fixtures/memory-embeddings.test-support.js';

const OWNER = 'a'.repeat(64);
const JELLYBEAN = '7eafb2e0cc049a9b3345f4322024b604358af04cb551d1fc71084ca3a99d7877';
const ROOM = '22222222-2222-4222-8222-222222222222';
const TRIAGE = 'a914716f-cd6c-4663-b42a-6e1044dc2bb9';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const SECRET = 'isolated-sentry-signing-secret';
const STANDING_COMMAND = 'd2b76f066b956e94428a559e5510339637fe235a5e2d39874c4974121e60e89b';
// Native cases include the complete release migration before sending requests.
const postgresUrl = process.env.BEELINE_SENTRY_TEST_POSTGRES_URL;
if (postgresUrl && !['127.0.0.1','localhost','[::1]'].includes(new URL(postgresUrl).hostname))
  throw new Error('Sentry wake proofs require isolated loopback PostgreSQL');
let db: ClosableDatabase;
let cleanup: (() => Promise<void>) | undefined;
let server: ReturnType<typeof createBeelineServer>;
let origin: string;
afterEach(async () => {
  if (server) await new Promise<void>(r => server.close(() => r()));
  if (db) await db.close();
  await cleanup?.();
  cleanup = undefined;
});
async function fixture(agentId = JELLYBEAN) {
  if (postgresUrl) {
    const schema = `sentry_proof_${randomUUID().replaceAll('-','')}`;
    const admin = new Pool({ connectionString: postgresUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new PostgresDatabase('',5,{mode:'migration',pool:new Pool({connectionString:postgresUrl,
      options:`-c search_path=${schema},public`,max:5})});
    cleanup = async () => { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); };
    await migrate(db);
  } else db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Jellybean')`,[OWNER,JELLYBEAN]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[JELLYBEAN,OWNER]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Isolated Sentry proof')`,[WORKSPACE]);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`,[ROOM,WORKSPACE,OWNER]);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name,parent_id) VALUES($1,$2,$3,'issues-triage',$4)`,[TRIAGE,WORKSPACE,OWNER,ROOM]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
    ($1,NULL,$2,'owner'),($1,NULL,$4,'member'),($1,$3,$2,'owner'),($1,$3,$4,'member')`,[WORKSPACE,OWNER,ROOM,JELLYBEAN]);
  await seedDefinition();
  server = createBeelineServer({database:db,auth:{},phone:{},daemon:{},live:new LiveHub(),mediaMaximumBytes:1,
    sentryWakeSecret:SECRET,sentryWakeAgentId:agentId} as unknown as ServerOptions);
  await new Promise<void>(r => server.listen(0,'127.0.0.1',r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function seedDefinition(agentId = JELLYBEAN, id = STANDING_COMMAND) {
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Keep the Sentry digest')
    ON CONFLICT DO NOTHING`, [`standing-${agentId}`,TRIAGE,OWNER]);
  const command = await createAgentCommand(db, { roomId: TRIAGE, agentId, id,
    sourceMessageId: `standing-${agentId}`, reason: 'human_tag' });
  if (agentId === JELLYBEAN) await seedSentryDigestAuthority(db);
  else await db.query('UPDATE sentry_wake_state SET requester_command_id=$1 WHERE singleton', [command!.id]);
  return command!;
}
function issue(id = '123', action = 'created', substatus = 'new') {
  return {action,data:{issue:{id,title:`Issue ${id}`,level:'fatal',culprit:'fixture',count:'7',
    firstSeen:'2026-10-17T20:00:00Z',lastSeen:'2026-10-17T20:01:00Z',substatus}}};
}
function post(payload: unknown, resource = 'issue', signature?: string) {
  const raw = JSON.stringify(payload);
  return fetch(`${origin}/v1/sentry/webhook`,{method:'POST',body:raw,headers:{
    'content-type':'application/json','sentry-hook-resource':resource,
    'sentry-hook-signature':signature ?? createHmac('sha256',SECRET).update(raw).digest('hex'),
  }});
}
const commands = () => db.query<{agent_id:string;room_id:string;private_payload:{text:string};source_message_id:null}>(
  `SELECT agent_id,room_id,private_payload,source_message_id FROM agent_commands WHERE reason='subscribed_event' ORDER BY created_at,id`);

it('defaults the server setting to Jellybean and validates configured agent keys', () => {
  expect(sentryWakeAgentFromEnv({})).toBe(JELLYBEAN);
  expect(sentryWakeAgentFromEnv({BEELINE_SENTRY_TRIAGE_AGENT_ID:'b'.repeat(64)})).toBe('b'.repeat(64));
  expect(() => sentryWakeAgentFromEnv({BEELINE_SENTRY_TRIAGE_AGENT_ID:'invalid'})).toThrow('agent public key');
});

it('R-NOISE-12: routes HTTP digests to the configured agent for the morning card', async () => {
  const agentId = sentryWakeAgentFromEnv({BEELINE_SENTRY_TRIAGE_AGENT_ID:'b'.repeat(64)});
  await fixture(agentId);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Configured triager')`,[agentId]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[agentId,OWNER]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member')`,[WORKSPACE,ROOM,agentId]);
  await seedDefinition(agentId, 'configured-standing-command');
  expect((await post(issue())).status).toBe(200);
  expect((await post(issue('456'))).status).toBe(200);
  expect((await commands()).rows.map(row => row.agent_id)).toEqual([agentId, agentId]);
  for (const command of (await commands()).rows) {
    expect(command.private_payload.text).toContain('keep for the morning card');
    expect(command.private_payload.text).not.toContain('open and own a fix corner');
  }
  await flushSentryWakes(db,agentId);
  expect((await commands()).rows.map(row => row.agent_id)).toEqual([agentId,agentId]);
}, postgresUrl ? 60_000 : 20_000);

it('rejects bad signatures and leaves noncanonical issue notifications quiet', async () => {
  await fixture();
  expect((await post(issue(),'issue','')).status).toBe(401);
  expect((await post(issue(),'issue','a'.repeat(64))).status).toBe(401);
  expect((await post({action:'created',data:{issue:{title:'No id'}}})).status).toBe(400);
  expect((await post(issue('123','resolved'))).status).toBe(202);
  expect((await commands()).rowCount).toBe(0);
  for (const action of ['unresolved','regressed','resolved'])
    expect((await post(issue('123',action))).status).toBe(202);
  expect((await commands()).rowCount).toBe(0);
}, postgresUrl ? 60_000 : 20_000);

it('keeps the batch pending if the target corner is archived', async () => {
  await fixture();
  await db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`,[TRIAGE]);
  expect((await post(issue())).status).toBe(409);
  expect((await commands()).rowCount).toBe(0);
  expect((await db.query(`SELECT 1 FROM sentry_wake_issues WHERE pending`)).rowCount).toBe(1);
  await db.query(`UPDATE rooms SET archived_at=NULL WHERE id=$1`,[TRIAGE]);
  await flushSentryWakes(db);
  expect((await commands()).rowCount).toBe(1);
}, postgresUrl ? 60_000 : 20_000);

it('records distinct issue and alert observations without an urgency gate', async () => {
  await fixture();
  const variants = [
    {issue:{...issue('801').data.issue,level:'error',isUnhandled:true}},
    {event:{issue_id:'802',title:'Tag object',level:'error',datetime:'2026-10-17T20:00:00Z',tags:{handled:'no'}}},
    {event:{issue_id:'803',title:'Tag pairs',level:'error',datetime:'2026-10-17T20:00:00Z',tags:[['handled','no']]}},
    {event:{issue_id:'804',title:'Unhandled flag',level:'error',datetime:'2026-10-17T20:00:00Z',unhandled:true}},
    {event:{issue_id:'805',title:'Handled',level:'error',datetime:'2026-10-17T20:00:00Z',exception:{values:[{mechanism:{handled:true}}]}}},
  ];
  for (const data of variants) {
    const event = 'event' in data;
    expect((await post({action:event ? 'triggered' : 'created',data},event ? 'event_alert' : 'issue')).status).toBe(200);
  }
  expect((await db.query(`SELECT issue_id FROM sentry_wake_issues ORDER BY issue_id`)).rows).toEqual([
    {issue_id:'801'},{issue_id:'802'},{issue_id:'803'},{issue_id:'804'},{issue_id:'805'},
  ]);
}, postgresUrl ? 60_000 : 20_000);

it.each(['issue-first','alert-first'] as const)('one new Sentry event produces one digest (%s), including replays', async order => {
  await fixture();
  const created = issue('901');
  created.data.issue.count = '1';
  const alert = {action:'triggered',data:{event:{issue_id:'901',title:'Issue 901',level:'fatal',
    datetime:created.data.issue.firstSeen}}};
  // A new issue's created webhook describes its first event, like the paired alert.
  created.data.issue.lastSeen = created.data.issue.firstSeen;
  const arrivals = order === 'issue-first' ? [[created,'issue'],[alert,'event_alert']] as const
    : [[alert,'event_alert'],[created,'issue']] as const;
  for (const [payload, resource] of [...arrivals,...arrivals])
    expect((await post(payload,resource)).status).toBe(200);
  expect((await commands()).rowCount).toBe(1);
  // Different rule/body metadata still describes the same first occurrence.
  created.data.issue.title = 'Updated issue title';
  expect((await post(created)).status).toBe(200);
  expect((await commands()).rowCount).toBe(1);
  // A regression/threshold alert for a later occurrence still wakes once.
  alert.data.event.datetime = '2026-10-18T12:00:00Z';
  expect((await post(alert,'event_alert')).status).toBe(200);
  expect((await post(alert,'event_alert')).status).toBe(200);
  expect((await post({...alert,data:{...alert.data,triggered_rule:'Another alert rule'}},'event_alert')).status).toBe(200);
  expect((await commands()).rowCount).toBe(2);
});

it('the seeded digest root authorizes connected Sentry lookup and memory search/save', async () => {
  await fixture();
  stubMemoryEmbeddings({}, undefined, fetch);
  await seedSentryDigestAuthority(db); // Release migration is safe to repeat.
  await db.query(`INSERT INTO institutional_memory_workspace_rollouts(workspace_id,stage) VALUES($1,'live')
    ON CONFLICT(workspace_id) DO UPDATE SET stage='live'`,[WORKSPACE]);
  const appId = randomUUID();
  await db.query(`INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,transport,route)
    VALUES($1,$2,$3,'sentry','Sentry','squire-api','squire-api')`,[appId,WORKSPACE,OWNER]);
  expect((await post(issue())).status).toBe(200);
  const command = (await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE reason='subscribed_event'`)).rows[0]!;
  expect(command.parent_command_id).toBe(STANDING_COMMAND);
  expect(command.root_command_id).toBe(STANDING_COMMAND);
  expect(command.root_source_message_id).toBe(`standing-${JELLYBEAN}`);
  await startQueuedTurn(db,TRIAGE,JELLYBEAN,command.id);
  const daemon = new DaemonService(db,new LiveHub(),undefined,undefined,false,undefined,false,undefined,undefined,
    undefined,{enabled:true,live:true});
  const turn = {roomId:TRIAGE,requestId:command.turn_request_id};
  expect(await daemon.execute('authorizeResourceCall', {...turn,target:'registry-mcp:io.sentry/sentry',operation:'GET /api/0/issues/123/'},JELLYBEAN))
    .toMatchObject({allowed:true});
  expect((await db.query('SELECT requester_id FROM workspace_app_usage WHERE app_id=$1',[appId])).rows)
    .toEqual([{requester_id:OWNER}]);
  expect(await daemon.execute('searchInstitutionalMemory',{...turn,query:'Sentry issue'},JELLYBEAN))
    .toHaveProperty('results');
  expect(await daemon.execute('saveInstitutionalMemory',{...turn,memoryKind:'workspace_fact',canonicalKey:'sentry.123',
    body:'Sentry issue 123 was observed.',keywords:['sentry'],sourceMessageIds:[`standing-${JELLYBEAN}`],
    personAsked:false,confidence:1},JELLYBEAN)).toMatchObject({version:1});
});

it('uses explicit occurrence evidence for old issues and keeps missing timestamps quiet', async () => {
  await fixture();
  const first = issue('902');
  first.data.issue.lastSeen = first.data.issue.firstSeen;
  // A larger current issue count does not turn its first event into a later one.
  expect((await post({action:'triggered',data:{issue:first.data.issue}},'event_alert')).status).toBe(200);
  expect((await commands()).rowCount).toBe(0);
  expect((await post({action:'triggered',data:{event:{issue_id:'902',title:'Missing timestamp'}}},'event_alert')).status).toBe(202);
  expect((await commands()).rowCount).toBe(0);
  const later = issue('903');
  expect((await post({action:'triggered',data:{issue:later.data.issue}},'event_alert')).status).toBe(200);
  expect((await commands()).rowCount).toBe(1);
});

it('does not borrow a digest definition belonging to another agent or Room', async () => {
  await fixture();
  await db.query('UPDATE agent_commands SET room_id=$1 WHERE id=$2',[ROOM,STANDING_COMMAND]);
  expect((await post(issue())).status).toBe(200);
  expect((await commands()).rowCount).toBe(0);
  expect((await db.query('SELECT pending FROM sentry_wake_issues')).rows).toEqual([{pending:true}]);
});
