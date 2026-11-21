import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { vi } from 'vitest';
import {
  AGENT,
  CONFIG,
  CORNER,
  FIX_URL,
  OUTSIDER,
  REPOSITORY,
  ROOM,
  SYSTEM_IDENTITY_ID,
  describe,
  expect,
  fixtureScope5,
  it,
  report,
  rootFixture,
  triageTurn,
} from './test-support-feedback.test-support.js';
import type { FeedbackLoop, FeedbackPullRequests } from './feedback.js';
import { notifyFeedbackShipped } from './feedback-shipped.js';
import { applyFeedbackDispositions } from './feedback-dispositions.js';
import type { CommandRow } from './agent-command.js';
import { ReleaseNotifier } from './release-notify.js';

const RELEASE = { version: 'v0.1.243', sha: '1'.repeat(40) };
const EARLIER = { version: 'v0.1.242', sha: '2'.repeat(40) };
const SYSTEM_LINE_SEPARATOR = systemMessage('system-events.separator');
const ERROR = 'daemon operation report failed (503: GitHub PR checks failed: HTTP 404: Not Found)';

/** GitHub as the release step reads it: pull request 7 is in RELEASE and nothing else. */
const pullRequests: FeedbackPullRequests = {
  merged: async () => true,
  shipped: async (repository, number, sha) =>
    repository === REPOSITORY && number === 7 && sha === RELEASE.sha,
};
const loop: FeedbackLoop = { config: CONFIG, pullRequests };

async function shippedLines() {
  return (
    await rootFixture.database.query<{
      room_id: string;
      text: string;
      card_type: string;
      id: string;
    }>(
      `SELECT id,room_id,text,card_type FROM messages WHERE author_id=$1 AND card_type='feedback-shipped'
       ORDER BY room_id`,
      [SYSTEM_IDENTITY_ID],
    )
  ).rows;
}

async function notifiedAt(id: string) {
  return (
    await rootFixture.database.query<{ resolved_notified_at: Date | null }>(
      'SELECT resolved_notified_at FROM feedback_items WHERE id=$1',
      [id],
    )
  ).rows[0]!.resolved_notified_at;
}

describe('feedback fix shipped in a release', () => {
  const scope5 = fixtureScope5();

  async function fixedAgentReport() {
    const { itemId } = await report({
      summary: 'report fails on a missing PR',
      toolName: 'report',
      errorExcerpt: ERROR,
    });
    // A second agent hits the same error in another Room: one item, two reporters.
    await report(
      { summary: 'The report tool 404s', toolName: 'report', errorExcerpt: ERROR },
      CORNER,
      OUTSIDER,
    );
    const { actionItem } = await scope5.reported();
    await scope5.notify({ itemIds: [itemId, actionItem], notify: undefined });
    return { itemId, actionItem };
  }

  it('tells each reporting agent once, in the Room it reported from, after the release containing the fix', async () => {
    const { itemId, actionItem } = await fixedAgentReport();
    const commandsBefore = (await rootFixture.database.query('SELECT 1 FROM agent_commands'))
      .rowCount;

    await expect(notifyFeedbackShipped(rootFixture.database, loop, EARLIER)).resolves.toBe(0);
    expect(await shippedLines()).toEqual([]);
    expect(await notifiedAt(itemId)).toBeNull();

    await expect(notifyFeedbackShipped(rootFixture.database, loop, RELEASE)).resolves.toBe(2);
    const lines = await shippedLines();
    expect(
      lines
        .map(({ room_id, text }) => ({ room_id, text }))
        .sort((a, b) => a.text.localeCompare(b.text)),
    ).toEqual([
      {
        room_id: CORNER,
        text: `@outsider reported a problem fixed in ${RELEASE.version}${SYSTEM_LINE_SEPARATOR}Slow tools ${FIX_URL}`,
      },
      {
        room_id: ROOM,
        text: `@worker reported a problem fixed in ${RELEASE.version}${SYSTEM_LINE_SEPARATOR}Slow tools ${FIX_URL}`,
      },
    ]);
    expect(await notifiedAt(itemId)).toBeTruthy();
    // The human report keeps its own explicit Fixed DM path.
    expect(await notifiedAt(actionItem)).toBeNull();
    // The notice wakes nobody.
    expect((await rootFixture.database.query('SELECT 1 FROM agent_commands')).rowCount).toBe(
      commandsBefore,
    );

    // A repeat or promoted delivery of the same release sends nothing again.
    await expect(notifyFeedbackShipped(rootFixture.database, loop, RELEASE)).resolves.toBe(0);
    expect(await shippedLines()).toHaveLength(2);
  });

  async function assess(value: unknown) {
    const turn = await triageTurn();
    const command = (await rootFixture.database.query<CommandRow>(
      'SELECT * FROM agent_commands WHERE id=$1', [turn.requestId],
    )).rows[0]!;
    await rootFixture.database.transaction(db => applyFeedbackDispositions(db, command, value));
  }

  it('reconciles a fix resolved after its containing release was delivered', async () => {
    const { itemId } = await report({ summary: 'late resolution' });
    const notifier = new ReleaseNotifier(rootFixture.database, { feedback: loop });
    await notifier.notifyReleaseDelivered({ ...RELEASE, changelogUrl: 'https://example.test/243' });
    await expect(notifier.feedbackNotices).resolves.toBe(0);
    await scope5.notify({ itemIds: [itemId], notify: undefined });
    expect(await shippedLines()).toEqual([expect.objectContaining({
      room_id: ROOM,
      text: `@worker reported a problem fixed in ${RELEASE.version}${SYSTEM_LINE_SEPARATOR}Slow tools ${FIX_URL}`,
    })]);
    expect(await notifiedAt(itemId)).toBeTruthy();
  });

  it.each([false, true])('keeps merged agent and human notices independent (human first: %s)', async (humanFirst) => {
    const { agentItem, actionItem } = await scope5.reported();
    await assess([{ itemId: agentItem, disposition: 'duplicate', reference: actionItem, reason: 'Same cause' }]);
    await scope5.notify({ itemIds: [actionItem], notify: undefined });
    await assess([{ itemId: actionItem, disposition: 'fixed', reason: 'Private workspace assessment' }]);
    if (humanFirst) await scope5.notify({ itemIds: [actionItem] });
    await expect(notifyFeedbackShipped(rootFixture.database, loop, RELEASE)).resolves.toBe(1);
    expect(await shippedLines()).toEqual([expect.objectContaining({
      room_id: ROOM,
      text: `@worker reported a problem fixed in ${RELEASE.version}${SYSTEM_LINE_SEPARATOR}Slow tools ${FIX_URL}`,
    })]);
    expect(Boolean(await notifiedAt(actionItem))).toBe(humanFirst);
    await expect(notifyFeedbackShipped(rootFixture.database, loop, RELEASE)).resolves.toBe(0);
    await scope5.notify({ itemIds: [actionItem] });
    expect(await scope5.fixedDms()).toHaveLength(1);
    expect(await notifiedAt(actionItem)).toBeTruthy();
    expect(await shippedLines()).toHaveLength(1);
  });

  it('chooses the latest report timestamp across items and out-of-order merged occurrences', async () => {
    const first = (await report({ summary: 'first problem' })).itemId;
    const second = (await report({ summary: 'second problem' }, CORNER)).itemId;
    const duplicate = (await report({ summary: 'legacy duplicate' }, CORNER)).itemId;
    await rootFixture.database.query(`UPDATE feedback_items SET created_at=$2 WHERE id=$1`,
      [first, '2026-01-01T01:00:00Z']);
    await rootFixture.database.query(`UPDATE feedback_items SET created_at=$2 WHERE id=$1`,
      [second, '2026-01-01T02:00:00Z']);
    await rootFixture.database.query(`UPDATE feedback_items SET created_at=$2 WHERE id=$1`,
      [duplicate, '2026-01-01T03:00:00Z']);
    await rootFixture.database.query(`UPDATE feedback_items SET occurrences=$2::jsonb WHERE id=$1`,
      [first, JSON.stringify([{ agentId: AGENT, roomId: ROOM, createdAt: '2026-01-01T05:00:00Z' }])]);
    await assess([{ itemId: duplicate, disposition: 'duplicate', reference: first, reason: 'Same cause' }]);
    await scope5.notify({ itemIds: [first, second], notify: undefined });
    await expect(notifyFeedbackShipped(rootFixture.database, loop, RELEASE)).resolves.toBe(1);
    expect(await shippedLines()).toEqual([expect.objectContaining({ room_id: ROOM })]);
  });

  it('leaves the fix pending when GitHub cannot be read, for the next release to retry', async () => {
    const { itemId } = await fixedAgentReport();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing: FeedbackLoop = {
      config: CONFIG,
      pullRequests: {
        ...pullRequests,
        shipped: async () => {
          throw new Error('GitHub unavailable');
        },
      },
    };
    await expect(notifyFeedbackShipped(rootFixture.database, failing, RELEASE)).resolves.toBe(0);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
    expect(await notifiedAt(itemId)).toBeNull();
    await expect(notifyFeedbackShipped(rootFixture.database, loop, RELEASE)).resolves.toBe(2);
  });

  it('runs on the release delivery step without holding up its response', async () => {
    const { itemId } = await fixedAgentReport();
    const notifier = new ReleaseNotifier(rootFixture.database, { feedback: loop });
    await expect(
      notifier.notifyReleaseDelivered({ ...RELEASE, changelogUrl: 'https://example.test/243' }),
    ).resolves.toEqual({ notified: 0, skipped: 0 });
    await expect(notifier.feedbackNotices).resolves.toBe(2);
    expect(await notifiedAt(itemId)).toBeTruthy();
  });
});
