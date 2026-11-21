import { vi } from 'vitest';
import {
  AGENT,
  CONFIG,
  CORNER,
  FIX_URL,
  OUTSIDER,
  REPOSITORY,
  ROOM,
  TRIAGE,
  SYSTEM_IDENTITY_ID,
  describe,
  expect,
  fixtureScope5,
  it,
  report,
  rootFixture,
  triageTurn,
} from './test-support-feedback.test-support.js';
import { notifyFeedbackFixed, type FeedbackLoop, type FeedbackPullRequests } from './feedback.js';
import { notifyFeedbackShipped } from './feedback-shipped.js';
import { applyFeedbackDispositions } from './feedback-dispositions.js';
import type { CommandRow } from './agent-command.js';
import type { AfterCommit } from './institutional-memory-embeddings.js';
import { FEEDBACK_TRIAGE_CONTRACT } from './feedback-triage-workflow.js';
import { handoff, saveWorkflow, startWorkflow } from './workflow-runs.js';
import { ReleaseNotifier } from './release-notify.js';

const RELEASE = { version: 'v0.1.243', sha: '1'.repeat(40) };
const EARLIER = { version: 'v0.1.242', sha: '2'.repeat(40) };
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
        .sort((a, b) => b.room_id.localeCompare(a.room_id)),
    ).toEqual([
      {
        room_id: CORNER,
        text: `Fixed in ${RELEASE.version}: ${FIX_URL}`,
      },
      {
        room_id: ROOM,
        text: `Fixed in ${RELEASE.version}: ${FIX_URL}`,
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
    await vi.waitFor(async () => expect(await shippedLines()).toHaveLength(1));
    expect(await shippedLines()).toEqual([expect.objectContaining({
      room_id: ROOM,
      text: `Fixed in ${RELEASE.version}: ${FIX_URL}`,
    })]);
    expect(await notifiedAt(itemId)).toBeTruthy();
  });

  it('defers release reads until the outer resolution transaction commits', async () => {
    const { itemId } = await report({ summary: 'deferred resolution' });
    const turn = await triageTurn();
    const command = (await rootFixture.database.query<CommandRow>(
      'SELECT * FROM agent_commands WHERE id=$1', [turn.requestId],
    )).rows[0]!;
    const tasks: Parameters<AfterCommit>[0][] = [];
    const shipped = vi.fn(pullRequests.shipped);
    const feedback = { config: CONFIG, pullRequests: { ...pullRequests, shipped } };
    await rootFixture.database.transaction(async db => {
      await notifyFeedbackFixed(db, feedback, command, TRIAGE,
        { itemIds: [itemId], title: 'Private fix title', prUrl: FIX_URL }, task => tasks.push(task));
      expect(shipped).not.toHaveBeenCalled();
      expect(tasks).toHaveLength(1);
    });
    const notifier = new ReleaseNotifier(rootFixture.database);
    await notifier.notifyReleaseDelivered({ ...RELEASE, changelogUrl: 'https://example.test/243' });
    await tasks[0]!(rootFixture.database);
    expect(shipped).toHaveBeenCalledWith(REPOSITORY, 7, RELEASE.sha);
    expect(await shippedLines()).toEqual([expect.objectContaining({
      text: `Fixed in ${RELEASE.version}: ${FIX_URL}`,
    })]);
  });

  it.each([false, true])('reconciles late duplicate evidence after handoff commit (prior agent: %s)', async priorAgent => {
    const { agentItem, actionItem } = await scope5.reported();
    if (priorAgent)
      await assess([{ itemId: agentItem, disposition: 'duplicate', reference: actionItem, reason: 'Same cause' }]);
    await scope5.notify({ itemIds: [actionItem], notify: undefined });
    const notifier = new ReleaseNotifier(rootFixture.database, { feedback: loop });
    await notifier.notifyReleaseDelivered({ ...RELEASE, changelogUrl: 'https://example.test/243' });
    await expect(notifier.feedbackNotices).resolves.toBe(priorAgent ? 1 : 0);
    const lateItem = (await report({ summary: 'late separate report' }, CORNER, OUTSIDER)).itemId;
    const turn = await triageTurn();
    const command = (await rootFixture.database.query<CommandRow>(
      'SELECT * FROM agent_commands WHERE id=$1', [turn.requestId],
    )).rows[0]!;
    await saveWorkflow(rootFixture.database, command, { contract: FEEDBACK_TRIAGE_CONTRACT });
    const { runId } = await startWorkflow(rootFixture.database, command,
      { name: 'feedback-triage', roleBindings: { triager: TRIAGE } });
    await handoff(rootFixture.database, command, { runId, outcome: 'notified',
      contents: { fixedPullRequests: [], skipReason: 'none', unnotifiedPullRequests: [] } });
    await handoff(rootFixture.database, command, { runId, attempt: 1, outcome: 'checked', contents: { signalChecks: [] } });
    const tasks: Parameters<AfterCommit>[0][] = [];
    const input = { runId, attempt: 2, outcome: 'ranked', contents: { problems: [], dispositions: [
      { itemId: lateItem, disposition: 'duplicate', reference: actionItem, reason: 'Private duplicate assessment' },
    ] } };
    await rootFixture.database.transaction(async db => {
      await handoff(db, command, input, loop, task => tasks.push(task));
      expect(tasks).toHaveLength(1);
    });
    expect(await shippedLines()).toHaveLength(priorAgent ? 1 : 0);
    await tasks[0]!(rootFixture.database);
    const lines = await shippedLines();
    expect(lines).toHaveLength(priorAgent ? 2 : 1);
    expect(lines).toContainEqual(expect.objectContaining({ room_id: CORNER,
      text: `Fixed in ${RELEASE.version}: ${FIX_URL}` }));
    expect(await notifiedAt(actionItem)).toBeNull();
    await handoff(rootFixture.database, command, input, loop, task => tasks.push(task));
    expect(tasks).toHaveLength(1);
    await expect(notifyFeedbackShipped(rootFixture.database, loop, RELEASE)).resolves.toBe(0);
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
      text: `Fixed in ${RELEASE.version}: ${FIX_URL}`,
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
