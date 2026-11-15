import { beforeEach, describe, expect, it } from 'vitest';
import { PhoneService } from './phone-service.js';
import { PgliteDatabase, migratedDatabase } from './test-support.js';

const VIEWER = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333';
const HEAD = 'd'.repeat(40);

describe('the Tags merge approval', () => {
  let database: PgliteDatabase;
  let phone: PhoneService;
  let sequence = 0;

  /** A needs-decision report to the viewer as commander. */
  async function post(roomId: string, text: string, attachments: unknown[] = []): Promise<string> {
    sequence += 1;
    const id = sequence.toString(16).padStart(64, '0');
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,attachments,card,created_at)
       VALUES($1,$2,$3,$4,$5::jsonb,jsonb_build_object('reportToId',$6::text),now() - interval '5 minutes')`,
      [id, roomId, AGENT, `needs-decision: ${text}`, JSON.stringify(attachments), VIEWER],
    );
    return id;
  }
  const read = (viewer = VIEWER) => phone.execute('readNeedsYou', { workspaceId: WORKSPACE }, viewer);
  const count = async (viewer = VIEWER) =>
    (await phone.execute('countNeedsYou', { workspaceId: WORKSPACE }, viewer)).count;

  beforeEach(async () => {
    sequence = 0;
    database = await migratedDatabase();
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
         ($1,'human','Ada','ada'),($2,'human','Juniper','juniper'),($3,'agent','Jimmy','jimmy')`,
      [VIEWER, PEER, AGENT],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES
         ($1,$3,NULL,'beeline'),($2,$3,$1,'reconnect-keeps-place')`,
      [ROOM, CORNER, WORKSPACE],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),
       ($1,$5,$2,'owner'),($1,$5,$3,'member'),($1,$5,$4,'member')`,
      [WORKSPACE, VIEWER, PEER, AGENT, ROOM],
    );
    await database.query(`INSERT INTO corner_facts(corner_id) VALUES($1)`, [CORNER]);
    await database.query(
      `INSERT INTO corner_github_cache(corner_id,lifecycle) VALUES($1,$2::jsonb)
       ON CONFLICT(corner_id) DO UPDATE SET lifecycle=EXCLUDED.lifecycle`,
      [CORNER, JSON.stringify({
        lifecycle: 'in-review',
        checks: 'passing',
        pr: { number: 4181, url: 'https://github.com/o/beeline/pull/4181',
          title: 'Keep the transcript still when the connection returns', targetBranch: 'main', headSha: HEAD },
        checksSummary: { status: 'passing', total: 14, failing: [], checks: [], updatedAt: 1 },
      })],
    );
    phone = new PhoneService(database, 'https://server.example');
  });

  it('turns a corner ask to approve its own PR into a merge approval for a Workspace owner', async () => {
    const ask = await post(CORNER, 'please approve merge of PR #4181 once checks pass.');
    const { items } = await read();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      messageId: ask,
      roomId: CORNER,
      text: 'please approve merge of PR #4181 once checks pass.',
      approval: {
        kind: 'merge',
        actor: 'Jimmy',
        ask: 'asks to merge',
        subject: 'Keep the transcript still when the connection returns',
        pullRequest: {
          number: 4181,
          title: 'Keep the transcript still when the connection returns',
          url: 'https://github.com/o/beeline/pull/4181',
          checks: { status: 'passing', total: 14, failing: 0 },
        },
      },
    });
    // No inline action: older phones would show an Approve that does nothing.
    expect(items[0]!.approval!.actions).toBeUndefined();
    expect(items[0]!.expiresAt).toBeUndefined();
    expect(await count()).toBe(1);
  });

  it('keeps the ask a plain question for a member who cannot approve, or for another PR number', async () => {
    await database.query(`UPDATE memberships SET role='member' WHERE identity_id=$1 AND room_id IS NULL`, [VIEWER]);
    await post(CORNER, 'please approve merge of PR #4181.');
    expect((await read()).items[0]?.approval).toBeUndefined();
    await database.query(`UPDATE memberships SET role='owner' WHERE identity_id=$1 AND room_id IS NULL`, [VIEWER]);
    await database.query(`UPDATE needs_you_marks SET cleared_at=now()`);
    await database.query(`DELETE FROM messages`);
    await post(CORNER, 'please approve merge of PR #41.');
    expect((await read()).items[0]?.approval).toBeUndefined();
  });

  it('leaves the tray and the count once a yes is recorded on the current head', async () => {
    await post(CORNER, 'please approve merge of PR #4181.');
    expect(await count()).toBe(1);
    await database.query(
      `INSERT INTO corner_merge_approvals(corner_id,approved_by,pull_request_number,head_sha) VALUES($1,$2,4181,$3)`,
      [CORNER, PEER, HEAD],
    );
    expect((await read()).items).toEqual([]);
    expect(await count()).toBe(0);
    // A new head cancels the yes, so the ask is open again.
    await database.query(
      `UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}','"${'e'.repeat(40)}"') WHERE corner_id=$1`,
      [CORNER],
    );
    expect((await read()).items.map((item) => item.approval?.kind)).toEqual(['merge']);
  });

  it('carries the asking message’s first image, with a relative URL made absolute', async () => {
    await post(CORNER, 'please approve merge of PR #4181, screenshot attached.', [
      { url: '/media/notes.txt', name: 'notes.txt', mimeType: 'text/plain', size: 3 },
      { url: '/media/shot.png', name: 'shot.png', mimeType: 'image/png', size: 9, width: 390, height: 250 },
    ]);
    expect((await read()).items[0]?.approval?.image).toEqual({
      url: 'https://server.example/media/shot.png', name: 'shot.png', mimeType: 'image/png', size: 9, width: 390, height: 250,
    });
  });

  it('gives a Trusty Squire approval its own facts', async () => {
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
       VALUES('squire-1',$1,$2,'card','card','squire-approval',$3::jsonb)`,
      [ROOM, AGENT, JSON.stringify({
        agent: { pubkey: AGENT, kind: 'agent', name: 'Jimmy' }, tool: 'inject_card', title: 'Pay Fly.io',
        action: 'pay Fly.io $12.40', reason: 'One hour of a performance-2x machine', approvalId: 'p-1',
        approvalUrl: 'https://squire.example/approve/p-1', sourceRoomId: CORNER, expiresAt: Date.now() + 600_000,
        facts: [{ label: 'Card', value: 'Card ending 4242' }, { label: 'Amount', value: '$12.40' }],
      })],
    );
    expect((await read()).items[0]?.approval).toMatchObject({
      kind: 'squire',
      facts: [{ label: 'Card', value: 'Card ending 4242' }, { label: 'Amount', value: '$12.40' }],
    });
  });
});
