import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { vi } from 'vitest';
import {
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
} from './test-support-feedback.test-support.js';
import type { FeedbackLoop, FeedbackPullRequests } from './feedback.js';
import { notifyFeedbackShipped } from './feedback-shipped.js';
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
