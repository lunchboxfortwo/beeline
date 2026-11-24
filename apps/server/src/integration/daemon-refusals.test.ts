import * as Sentry from '@sentry/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT, ROOM, monolithFixture } from '../test-fixtures/test-support-monolith.js';

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

  it('leaves a queued reply unanswered when its text is missing', async () => {
    const response = await fixture.daemonOperation('postRoomMessage', { agentId: AGENT, roomId: ROOM });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ answered: false });
    expect(Sentry.captureException).not.toHaveBeenCalled();
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
