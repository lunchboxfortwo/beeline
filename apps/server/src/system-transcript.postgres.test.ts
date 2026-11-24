import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readRoomViewMessage, type SystemEvent } from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { SCHEDULE_SCHEDULER_ID } from '@beeline/api-contract/scheduled-prompts';
import { queueMessage } from './agent-command.js';
import { migrate, PostgresDatabase } from './database.js';
import { LiveHub } from './live.js';
import { personText } from './message-origin.js';
import { PhoneService } from './phone-service.js';
import {
  connectorOfferDecisionLines, ensureSystemIdentity, restateSystemLines, sendSystemDirectMessage,
  settleSystemCard, systemLine, systemLineInRooms, type SystemLineInput,
} from './system-line.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('System transcript proof requires isolated loopback PostgreSQL');

describe.skipIf(!url)('system transcript writes on PostgreSQL', () => {
  const name = `system_transcript_${randomUUID().replaceAll('-', '')}`;
  const isolated = new URL(url ?? 'postgresql://localhost/postgres');
  isolated.pathname = `/${name}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  const database = new PostgresDatabase('', 2, { pool: new Pool({ connectionString: isolated.href, max: 2 }) });
  const phone = new PhoneService(database, new LiveHub());
  const workspace = randomUUID(), room = randomUUID(), otherRoom = randomUUID();
  const person = 'a'.repeat(64), agent = 'b'.repeat(64);
  const marker = () => randomBytes(32).toString('hex');
  const notice = { origin: 'system', visibility: 'notice' };

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${name}`);
    await migrate(database);
    await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Ada','ada'),($2,'agent','Bee','bee')`, [person, agent]);
    await database.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agent, person]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'System transcript proof')`, [workspace]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name,created_by)
      VALUES($1,$3,'Room',$4),($2,$3,'Other Room',$4)`, [room, otherRoom, workspace, person]);
    for (const member of [person, agent]) {
      await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,NULL,$4,'owner'),($1,$2,$4,'member'),($1,$3,$4,'member')`, [workspace, room, otherRoom, member]);
    }
    await ensureSystemIdentity(database);
  }, 60_000);

  afterAll(async () => {
    await database.close();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  });

  const readRoom = async () => (await phone.readRoom(room, person))!.messages;
  const readHistory = async () => (await phone.readHistory(room, person))!.messages;
  async function readDelta(id: string) {
    const delta = await phone.readLiveDelta(room, person, { type: 'message', messageId: id });
    return delta?.type === 'message-delta' ? delta.message : undefined;
  }

  it('batches actor notices and routes only the winning hidden connector receipt', async () => {
    await systemLineInRooms(database, workspace, [room, otherRoom], {
      subject: { kind: 'person', id: person, name: 'Ada' }, verb: 'updated agent settings',
    });
    const copies = (await database.query(`SELECT room_id,author_id,system_transcript FROM messages
      WHERE system_event->>'verb'='updated agent settings'`)).rows;
    expect(copies).toHaveLength(2);
    expect(copies).toEqual(expect.arrayContaining([room, otherRoom].map(room_id =>
      ({ room_id, author_id: person, system_transcript: notice }))));

    const asked = await queueMessage(database, { kind: 'post', roomId: room, authorId: person,
      text: personText('@bee connect the sample app'), agentIds: [agent] });
    const commandId = asked.commands[0]!.id;
    const id = marker(), offerId = randomUUID();
    const receipt: SystemLineInput & { kind: 'connector-offer-decided' } = {
      id, roomId: room, authorId: SYSTEM_IDENTITY_ID,
      subject: { kind: 'system', name: 'Connector setup' },
      verb: 'finished', kind: 'connector-offer-decided', commandId,
      cardType: 'connector-offer-decision', card: { offerId }, wakes: [agent],
    };
    await database.transaction(async tx => {
      await connectorOfferDecisionLines(tx, [receipt, receipt]);
      await connectorOfferDecisionLines(tx, [receipt]);
    });
    expect((await database.query('SELECT system_transcript,event_root_cause_id,event_depth FROM messages WHERE id=$1', [id])).rows)
      .toEqual([{ system_transcript: { origin: 'system', visibility: 'hidden' }, event_root_cause_id: id, event_depth: 0 }]);
    expect((await database.query('SELECT agent_id FROM agent_commands WHERE source_message_id=$1', [id])).rows)
      .toEqual([{ agent_id: agent }]);
    for (const rows of [await readRoom(), await readHistory()]) expect(rows.some(row => row.id === id)).toBe(false);
    expect(await readDelta(id)).toBeUndefined();
  });

  it('preserves a settled card id and time and projects all committed readers alike', async () => {
    const call = { id: randomUUID(), roomId: room, startedAt: 1_700_000_000, participants: [] };
    const started = await systemLine(database, {
      roomId: room, authorId: SYSTEM_IDENTITY_ID, presentation: 'card', cardType: 'voice-call', card: call,
      subject: { kind: 'system', name: 'Voice call' }, verb: 'started',
    });
    const endedAt = 1_800_000_000;
    await restateSystemLines(database, [{
      id: started.id, phrase: { subject: { kind: 'system', name: 'Voice call' }, verb: 'ended' },
      card: { ...call, endedAt }, presentation: 'system', createdAt: new Date(endedAt * 1_000),
    }]);
    const match = {
      id: started.id, text: 'Voice call ended', createdAt: endedAt, presentation: 'system',
      systemTranscript: notice, voiceCall: { ...call, endedAt },
    };
    for (const row of [(await readRoom()).find(row => row.id === started.id),
      (await readHistory()).find(row => row.id === started.id), await readDelta(started.id)]) {
      expect(readRoomViewMessage(row)).toMatchObject(match);
    }

    const approval = await systemLine(database, {
      roomId: room, authorId: SYSTEM_IDENTITY_ID, presentation: 'card', cardType: 'connector-offer',
      subject: { kind: 'system', name: 'Connector' }, verb: 'requested approval', card: {},
    });
    await settleSystemCard(database, approval.id, {
      authorId: person, subject: { kind: 'person', id: person, name: 'Ada' }, verb: 'approved',
    });
    expect((await database.query('SELECT author_id,card,card_type,system_transcript FROM messages WHERE id=$1', [approval.id])).rows)
      .toEqual([{ author_id: person, card: null, card_type: null, system_transcript: notice }]);
  });

  it('projects a historic workflow deadline from the pinned gate across full, paged and live reads', async () => {
    const workflowSlug = 'morning-card-24-nov';
    const skillId = randomUUID(), runId = marker(), expiryId = marker();
    await database.query(`INSERT INTO workspace_skills
      (id,workspace_id,slug,description,state,current_version,revision,source_room_id,repository,target_commit,kind)
      VALUES($1,$2,$3,'Synthetic workflow','active',1,1,$4,'','','workflow')`,
      [skillId, workspace, workflowSlug, room]);
    const markdown = JSON.stringify({ handoffs: { choose: { kind: 'gate' } } });
    await database.query(`INSERT INTO workspace_skill_versions
      (skill_id,version,markdown,content_hash,source_message_ids,repository,target_commit,extractor_version,model)
      VALUES($1,1,$2,$3,$4,'','','synthetic','synthetic')`,
      [skillId, markdown, createHash('sha256').update(markdown).digest('hex'), [runId]]);
    const old: SystemEvent = { subject: { kind: 'system', name: 'the workflow' },
      verb: 'applied', object: { text: 'timeout' }, consequence: 'choose' };
    await database.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,system_event)
      VALUES($1,$2,$3,'the workflow applied timeout · choose','system','workflow-handoff',$4::jsonb,$5::jsonb)`,
      [expiryId, room, SYSTEM_IDENTITY_ID, JSON.stringify({
        runId, workflowSlug, workflowVersion: 1, fromState: 'choose', outcome: 'expired',
      }), JSON.stringify(old)]);
    for (const row of [(await readRoom()).find(row => row.id === expiryId),
      (await readHistory()).find(row => row.id === expiryId), await readDelta(expiryId)]) {
      expect(row).toMatchObject({ id: expiryId, text: 'Approval timed out for Morning card 24 Nov', systemTranscript: notice });
      expect(row?.systemEvent?.kind).toBeUndefined();
    }
  });

  it('keeps an erased member message at its original position as a tombstone', async () => {
    const member = await queueMessage(database, {
      kind: 'post', roomId: room, authorId: person, text: personText('Synthetic original text'),
    });
    const deleted = await phone.deleteRoomMessage({ roomId: room, messageId: member.id }, person);
    expect(deleted).toMatchObject({
      id: member.id, presentation: 'system', deleted: true, systemTranscript: notice,
      createdAt: member.createdAt, author: { pubkey: person },
    });
    expect(deleted?.text).toContain('deleted a message');
    expect((await database.query('SELECT text,attachments FROM messages WHERE id=$1', [member.id])).rows)
      .toEqual([{ text: '', attachments: [] }]);
  });

  it('keeps operator text inert and refuses reserved authors on the conversational path', async () => {
    const id = marker(), text = '@bee  plain notice';
    expect(await sendSystemDirectMessage(database, workspace, person, text, id)).toBe(true);
    expect(await sendSystemDirectMessage(database, workspace, person, text, id)).toBe(false);
    const dm = (await database.query<{ room_id: string }>('SELECT room_id FROM messages WHERE id=$1', [id])).rows[0]!;
    const view = await phone.readRoom(dm.room_id, person);
    expect(view?.messages.find(row => row.id === id)).toMatchObject({
      text, presentation: 'system', systemTranscript: notice,
    });
    expect((await database.query('SELECT id FROM agent_commands WHERE source_message_id=$1', [id])).rowCount).toBe(0);

    for (const authorId of [SYSTEM_IDENTITY_ID, SCHEDULE_SCHEDULER_ID]) {
      const deniedId = marker();
      await expect(queueMessage(database, { kind: 'post', roomId: room, authorId, id: deniedId,
        text: personText('Synthetic bypass') })).rejects.toThrow('System transcript writes require systemLine');
      expect((await database.query('SELECT id FROM messages WHERE id=$1', [deniedId])).rowCount).toBe(0);
    }
  });
});
