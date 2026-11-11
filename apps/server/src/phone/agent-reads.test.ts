import { afterEach, describe, expect, it } from 'vitest';
import { PhoneService } from '../phone-service.js';
import { PgliteDatabase, migratedDatabase } from '../test-support.js';

const workspace = '11111111-1111-4111-8111-111111111111';
const shared = '22222222-2222-4222-8222-000000000001';
const hidden = '22222222-2222-4222-8222-000000000002';
const archived = '22222222-2222-4222-8222-000000000003';
const sharedCorner = '33333333-3333-4333-8333-000000000001';
const agent = 'a'.repeat(64);
const viewer = 'b'.repeat(64);
let database: PgliteDatabase;
afterEach(async () => database?.close());

describe('agent profile schedules and chats', () => {
  it('returns the agent schedules and Rooms the viewer shares, and omits the rest', async () => {
    database = await migratedDatabase();
    await database.query(
      `INSERT INTO identities(id,kind,name) VALUES ($1,'agent','Agent'),($2,'human','Viewer')`,
      [agent, viewer],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES ($1,'Workspace')`, [workspace]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES ($1,$2)`, [agent, viewer]);
    await database.query(
      `INSERT INTO memberships(workspace_id,identity_id,role) VALUES ($1,$2,'member'),($1,$3,'member')`,
      [workspace, agent, viewer],
    );
    await database.query(
      `INSERT INTO rooms(id,workspace_id,name,visibility) VALUES
         ($1,$4,'Shared','invite-only'),($2,$4,'Hidden','public'),($3,$4,'Archived','public')`,
      [shared, hidden, archived, workspace],
    );
    await database.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [archived]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES ($1,$2,$3,'Shared thread')`,
      [sharedCorner, workspace, shared],
    );
    // The agent is in all three Rooms; the viewer is only in Shared and Archived.
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,$2,$5,'member'),($1,$3,$5,'member'),($1,$4,$5,'member'),
         ($1,$2,$6,'member'),($1,$4,$6,'member')`,
      [workspace, shared, hidden, archived, agent, viewer],
    );
    const cadence = JSON.stringify({ kind: 'interval', everyMinutes: 1440 });
    const schedule = (id: string, roomId: string, nextRunAt: string) =>
      database.query(
        `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,'Check in',$7)`,
        [id, workspace, roomId, agent, viewer, cadence, nextRunAt],
      );
    await schedule('44444444-4444-4444-8444-000000000001', shared, '2030-01-02T00:00:00Z');
    await schedule('44444444-4444-4444-8444-000000000002', sharedCorner, '2030-01-01T00:00:00Z');
    await schedule('44444444-4444-4444-8444-000000000003', hidden, '2030-01-01T00:00:00Z');
    await schedule('44444444-4444-4444-8444-000000000004', archived, '2030-01-01T00:00:00Z');

    const detail = await new PhoneService(database, 'https://server.example').readAgent(workspace, agent, viewer);
    expect(detail?.rooms).toEqual([{ id: shared, name: 'Shared', visibility: 'invite-only' }]);
    expect(detail?.schedules?.map((row) => [row.id, row.roomId, row.corner?.name])).toEqual([
      ['44444444-4444-4444-8444-000000000002', sharedCorner, 'Shared thread'],
      ['44444444-4444-4444-8444-000000000001', shared, undefined],
    ]);
    expect(detail?.schedules?.[1]).toMatchObject({
      agentId: agent,
      message: 'Check in',
      cadence: { kind: 'interval', everyMinutes: 1440 },
      nextRunAt: Date.parse('2030-01-02T00:00:00Z') / 1000,
    });
  });
});
