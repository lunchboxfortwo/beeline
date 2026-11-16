import { describe, it, expect, rootFixture, inReview, open, currentState, mergedWebhook, SHA, A, H, saveWorkflow, startWorkflow, getWorkflowRun, describedWorkflow, type CommandRow } from './test-support-corner-lifecycle.test-support.js';
import { MCP_AGENT_TOOLS, MCP_RETIRED_TOOLS } from './rooms-mcp-agent.js';

async function event(cornerId: string, action = 'closed', number = 7) {
  await rootFixture.github.processWebhook('pull_request', {
    installation: { id: 77 }, repository: { id: 101, full_name: 'owner/widgets' }, action,
    pull_request: { number, title: 'Work', html_url: `https://github.com/owner/widgets/pull/${number}`,
      head: { ref: `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`, sha: SHA },
      base: { ref: 'main' }, merged: false, mergeable_state: 'clean' },
  });
}

describe('linked PR closure', () => {
  it.each([false, true])('archives an unlocked thread and cancels its work even with a hold=%s', async held => {
    const cornerId = await inReview();
    if (held) await rootFixture.phone.execute('setCornerHold', { cornerId }, H);
    const starter = { room_id: cornerId, agent_id: A } as CommandRow;
    await saveWorkflow(rootFixture.db, starter, { contract: describedWorkflow({
      version: 1, name: 'close-chore', description: 'Work in the thread', roles: ['worker'], start: 'work',
      handoffs: { work: { role: 'worker', requires: ['note'], on: { done: 'finished', timeout: 'failed' }, timeoutSeconds: 3600 },
        finished: { kind: 'terminal', status: 'done' }, failed: { kind: 'terminal', status: 'failed' } },
    }) });
    const { runId } = await startWorkflow(rootFixture.db, starter, { name: 'close-chore', roleBindings: { worker: A } });
    await event(cornerId);
    expect(await currentState(cornerId)).toBe('archived');
    expect((await getWorkflowRun(rootFixture.db, cornerId, runId)).status).toBe('abandoned');
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_commands WHERE room_id=$1 AND state IN ('pending','claimed')`, [cornerId])).rowCount).toBe(0);
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_turns WHERE room_id=$1 AND status='working'`, [cornerId])).rowCount).toBe(0);
    expect((await rootFixture.db.query(`SELECT 1 FROM corner_merge_holds WHERE corner_id=$1 AND released_at IS NULL`, [cornerId])).rowCount).toBe(0);
    await event(cornerId, 'reopened');
    expect(await currentState(cornerId)).toBe('archived');
  });

  it('leaves a locked thread open with its work intact', async () => {
    const cornerId = await inReview();
    await rootFixture.phone.execute('setCornerLocked', { roomId: cornerId, locked: true }, H);
    const before = (await rootFixture.db.query(`SELECT id,state FROM agent_commands WHERE room_id=$1 ORDER BY id`, [cornerId])).rows;
    await event(cornerId);
    expect((await rootFixture.db.query(`SELECT archived_at FROM rooms WHERE id=$1`, [cornerId])).rows[0].archived_at).toBeNull();
    expect((await rootFixture.db.query(`SELECT id,state FROM agent_commands WHERE room_id=$1 ORDER BY id`, [cornerId])).rows).toEqual(before);
    expect((await rootFixture.github.lifecycle(cornerId)).pr).toBeUndefined();
  });

  it('leaves a thread with no linked PR untouched', async () => {
    const cornerId = await open('owner/widgets');
    const before = await currentState(cornerId);
    await event(cornerId);
    expect(await currentState(cornerId)).toBe(before);
  });

  it('still lands a merged PR', async () => {
    const cornerId = await inReview();
    await mergedWebhook(cornerId, 7, SHA);
    expect(await currentState(cornerId)).toBe('archived');
    expect((await rootFixture.github.lifecycle(cornerId)).outcome).toBe('landed');
  });

  it('retires the separate PR-close tool in favor of close_thread', () => {
    expect(MCP_AGENT_TOOLS.map(tool => tool.name)).not.toContain('close_thread_pr');
    expect(MCP_AGENT_TOOLS.map(tool => tool.name)).toContain('close_thread');
    expect(MCP_RETIRED_TOOLS.close_thread_pr).toContain('close_thread');
  });
});
