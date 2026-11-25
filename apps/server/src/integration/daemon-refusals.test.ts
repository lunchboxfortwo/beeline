import * as Sentry from '@sentry/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentCommand } from '../agent-command.js';
import { AGENT, HUMAN, ROOM, monolithFixture } from '../test-fixtures/test-support-monolith.js';

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

describe('daemon request errors', () => {
  const fixture = monolithFixture();
  beforeEach(() => { vi.mocked(Sentry.captureException).mockClear(); });

  it.each([
    ['getConnectionDetail', {}, 400, 'connection reference is required'],
    ['getConnectionDetail', { ref: 'missing' }, 404, 'unknown connection reference missing'],
    ['getInstitutionalContext', {}, 409, 'institutional context requires an active command'],
    ['loadWorkspaceSkill', {}, 409, 'workspace skill load requires an active command'],
    ['saveSkill', {}, 409, 'skill save requires an active command'],
    ['deleteSkill', {}, 409, 'skill delete requires an active command'],
    ['saveWorkflow', {}, 409, 'workflow save requires an active command'],
    ['startWorkflow', {}, 409, 'workflow start requires an active command'],
    ['cancelWorkflowRun', {}, 409, 'workflow cancellation requires an active command'],
    ['handoff', {}, 409, 'workflow handoff requires an active command'],
    ['archiveWorkflow', {}, 409, 'workflow archive requires an active command'],
    ['assignWorkflowRole', {}, 409, 'workflow role assignment requires an active command'],
    ['postAgentThought', { roomId: ROOM }, 400, 'turnId is required'],
    ['postAgentModelCatalog', {}, 400, 'model options are required'],
    ['postAgentModelCatalog', { options: [] }, 400, 'model options are required'],
  ] as const)('%s with %j returns %i', async (name, input, status, message) => {
    const response = await fixture.daemonOperation(name, { agentId: AGENT, ...input });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: message });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('refuses a missing text field without completing the command that already posted a reply', async () => {
    const sourceId = 'd'.repeat(64);
    await fixture.database.query(
      'INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)',
      [sourceId, ROOM, HUMAN, 'Please publish a reply'],
    );
    const command = await createAgentCommand(fixture.database, {
      roomId: ROOM, agentId: AGENT, sourceMessageId: sourceId, reason: 'human_tag',
    });
    const request = { roomId: ROOM, requestId: command!.turn_request_id };
    const post = (operation: string, fields = {}) => fixture.request(
      '/v1/daemon/operations/' + operation, 'POST', { ...request, ...fields }, fixture.daemonToken,
    );
    expect((await post('startAgentTurn', {invocationId:'refusal-test'})).status).toBe(200);
    const posted = await post('message', {type:'reply', quoteMsgId:sourceId, text:'The public reply.'});
    expect(posted.status).toBe(200);
    const { id: replyId } = await posted.json();
    const readCommand = async () => (await fixture.database.query(
      'SELECT * FROM agent_commands WHERE id=$1', [command!.id],
    )).rows[0];
    const pending = await readCommand();
    expect(pending).toMatchObject({ state: 'pending', posted_reply_id: replyId, result_message_id: null });

    const refused = await post('postRoomMessage');
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'reply text is required' });
    expect(await readCommand()).toEqual(pending);
    expect(Sentry.captureException).not.toHaveBeenCalled();

    expect((await post('postRoomMessage', { text: '' })).status).toBe(200);
    expect(await readCommand()).toMatchObject({ state: 'complete', result_message_id: replyId });
  });

  it('rejects malformed bootstrap JSON', async () => {
    const response = await fetch(fixture.origin + '/v1/free-agents/bootstrap', { method: 'POST', body: '{' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid JSON request body' });
  });

  it.each([
    ['XX000', 'invalid page in block', 500],
    ['P0001', 'required record is missing', 500],
    ['57P01', 'restart required', 503],
  ] as const)('classifies database failure %s before matching its message', async (code, message, status) => {
    const failure = Object.assign(new Error(message), { code });
    vi.spyOn(fixture.database, 'query').mockRejectedValueOnce(failure);
    const response = await fetch(fixture.origin + '/health');
    expect(response.status).toBe(status);
    expect(Sentry.captureException).toHaveBeenCalledWith(failure, expect.anything());
  });

  it('returns an internal error for an unexpected database failure', async () => {
    vi.spyOn(fixture.database, 'query').mockRejectedValueOnce(new Error('unexpected database failure'));
    const response = await fetch(fixture.origin + '/health');
    expect(response.status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });
});
