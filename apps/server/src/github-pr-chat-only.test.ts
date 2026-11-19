import { describe, expect, it, GitHubAppClient, GitHubOAuthClient, GitHubOperations, PhoneService, REVIEWER, fixtureScope1 } from './test-support-github-operations.test-support.js';
import { visibleChatMessageSql } from './read-cursor.js';

describe('PR lifecycle cards belong to the parent chat', () => {
  const scope = fixtureScope1();

  it('posts one parent PR card, no thread opening, and hides legacy duplicates without hiding checks', async () => {
    const { corners, app, headSha, payload } = await scope.checksFixture();
    const corner = corners[0]!;
    const operations = new GitHubOperations(scope.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    await operations.processWebhook('pull_request', {
      ...payload, action: 'opened', pull_request: {
        number: 1, title: 'Setup: quiet defaults', html_url: 'https://github.com/owner/widgets/pull/1',
        head: { ref: 'feature/corner-333333330001', sha: headSha }, base: { ref: 'main' },
        mergeable_state: 'clean',
      },
    });
    const cards = (await scope.database.query(`SELECT m.room_id,m.card_type FROM messages m
      WHERE m.card_type IN ('github-event','github-corner-note') AND ${visibleChatMessageSql('m')}`)).rows;
    expect(cards).toEqual([{ room_id: '22222222-2222-4222-8222-222222222222', card_type: 'github-event' }]);
    expect((await scope.database.query(`SELECT 1 FROM messages WHERE room_id=$1
      AND system_event->>'verb'='opened a pull request'`, [corner])).rowCount).toBe(0);
    for (const [id, verb, kind] of [['old-open', 'opened a pull request', null], ['old-merge', 'merged', 'merged'], ['check', 'failed check', 'check-failed']]) {
      await scope.database.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,system_event)
        VALUES($1,$2,$3,'Legacy fact','system','github-corner-note',$4::jsonb)`,
      [id, corner, 'a'.repeat(64), JSON.stringify({ subject: { kind: 'github', name: 'GitHub' }, verb, ...(kind ? { kind } : {}), object: { text: 'Title', headSha } })]);
    }
    const phone = new PhoneService(scope.database, 'https://example.test');
    const view = await phone.readRoom(corner, REVIEWER);
    expect(view?.messages.find(message => message.id === 'check')?.text).toBe('Failed check 1111111');
    expect(view?.messages.map(message => message.id)).not.toContain('old-open');
    expect(view?.messages.map(message => message.id)).not.toContain('old-merge');
    expect((await scope.database.query(`SELECT m.id FROM messages m WHERE m.room_id=$1
      AND m.card_type='github-corner-note' AND ${visibleChatMessageSql('m')}`, [corner])).rows).toEqual([{ id: 'check' }]);
  });

  it('stores the failed head copy exactly and preserves the failure payload and wake source', async () => {
    const { corners, app, payload } = await scope.checksFixture();
    app.readCommitCheckRollup.mockResolvedValue({ state: 'failed', total: 1, failing: ['typecheck'], checks: [{ name: 'typecheck', status: 'failed' }] });
    const operations = new GitHubOperations(scope.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    await operations.processWebhook('check_run', payload);
    const rows = (await scope.database.query(`SELECT text,system_event FROM messages
      WHERE room_id=$1 AND system_event->>'kind'='check-failed'`, [corners[0]])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: 'Failed check 1111111', system_event: {
      verb: 'failed check', object: { text: '1111111', headSha: '1'.repeat(40) }, payload: { failedJobs: [{ name: 'typecheck' }] },
    } });
  });
});
