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
    ['postAgentThought', { roomId: ROOM }, 400, 'turnId is required'],
    ['postRoomMessage', { roomId: ROOM }, 400, 'reply text is required'],
    ['postAgentModelCatalog', {}, 400, 'model options are required'],
    ['postAgentModelCatalog', { options: [] }, 400, 'model options are required'],
  ] as const)('%s with %j returns %i', async (name, input, status, message) => {
    const response = await fixture.daemonOperation(name, { agentId: AGENT, ...input });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: message });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('rejects malformed bootstrap JSON', async () => {
    const response = await fetch(fixture.origin + '/v1/free-agents/bootstrap', { method: 'POST', body: '{' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid JSON request body' });
  });

  it('returns an internal error for an unexpected database failure', async () => {
    vi.spyOn(fixture.database, 'query').mockRejectedValueOnce(new Error('unexpected database failure'));
    const response = await fetch(fixture.origin + '/health');
    expect(response.status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });
});
