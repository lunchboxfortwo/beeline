import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { SqlDatabase } from './database.js';
import { AGENT_TURN_END_SCHEMA, endAgentTurn } from './agent-turn-end.js';

const pg = new PGlite();
const db = { query: async (sql: string, values: unknown[] = []) => {
  const result = await pg.query(sql, values);
  return { rows:result.rows, rowCount:result.rows.length || result.affectedRows || 0 };
} } as SqlDatabase;
beforeAll(async () => {
  await pg.exec(`CREATE TABLE agent_commands(id text PRIMARY KEY,room_id text,agent_id text,turn_request_id text,
    state text,reason text,report_outcome text,completed_at timestamptz,cancellation_reason text,result_message_id text);
    CREATE TABLE agent_turns(room_id text,agent_id text,request_id text,status text,
      failure_reason text,created_at timestamptz DEFAULT now());
    CREATE TABLE live_outputs(room_id text,agent_id text,turn_id text,kind text);
    ${AGENT_TURN_END_SCHEMA}`);
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(`DELETE FROM agent_commands; DELETE FROM agent_turns; DELETE FROM live_outputs;
    INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,state) VALUES('item','room','agent','request','pending');
    INSERT INTO agent_turns(room_id,agent_id,request_id,status) VALUES('room','agent','request','working');
    INSERT INTO live_outputs VALUES('room','agent','request','draft'),('room','agent','request','presence');`);
});
const item = async () => (await pg.query<{ state: string; result_message_id: string | null }>(
  'SELECT state,result_message_id FROM agent_commands')).rows[0];
const turn = async () => (await pg.query<{ status: string }>('SELECT status FROM agent_turns')).rows[0]?.status;

it('the answer completes a pending item once and records its message', async () => {
  expect(await endAgentTurn(db, { id: 'item' }, 'complete', null, 'answer')).toBe(true);
  expect(await item()).toEqual({ state: 'complete', result_message_id: 'answer' });
  expect(await turn()).toBe('working');
  await pg.query("SELECT beeline_record_agent_answer('item',false,NULL)");
  expect(await turn()).toBe('complete');
  expect((await pg.query('SELECT kind FROM live_outputs')).rows).toEqual([{ kind: 'presence' }]);
  // A resend after a crash is a no-op, never a second terminal write.
  expect(await endAgentTurn(db, { id: 'item' }, 'complete', null, 'other')).toBe(false);
  expect(await item()).toEqual({ state: 'complete', result_message_id: 'answer' });
});

it('Stop cancels a pending item and its answer cannot complete it later', async () => {
  expect(await endAgentTurn(db, { id: 'item' }, 'cancelled', 'stop')).toBe(true);
  expect((await item())?.state).toBe('cancelled');
  expect(await turn()).toBe('cancelled');
  expect(await endAgentTurn(db, { id: 'item' }, 'complete', null, 'late')).toBe(false);
  expect((await item())?.state).toBe('cancelled');
});

it('records a posted failure outcome before its optional turn projection', async () => {
  expect(await endAgentTurn(db, { id: 'item' }, 'failed', 'provider disconnected')).toBe(true);
  expect((await item())?.state).toBe('complete');
  expect(await turn()).toBe('working');
  await pg.query("SELECT beeline_record_agent_answer('item',true,'provider disconnected')");
  expect(await turn()).toBe('failed');
});
