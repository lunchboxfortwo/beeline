import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { agentCommandCatalogPublisher } from './agent-command-catalog.js';
import { beelineManagedSkills } from './beeline-skill.js';
import { DRAW_AVATAR_COMMAND } from './draw-avatar-skill.js';
import type { DaemonApiClient } from './daemon-api-client.js';

describe('agent command catalog publication', () => {
  it('matches the /draw-avatar row the composer offers before a catalog is published', () => {
    // Mobile cannot import the body, so it keeps a copy for agents with no published row.
    const mobile = readFileSync(new URL('../../mobile/sources/buzz/slash-verbs.ts', import.meta.url), 'utf8');
    for (const value of Object.values(DRAW_AVATAR_COMMAND)) expect(mobile).toContain(`'${value}'`);
  });

  it('publishes one Beeline draw-avatar command for harness skill aliases', () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const publish = agentCommandCatalogPublisher({ api: { execute } as unknown as DaemonApiClient, agentId: 'grunt', workspaceId: 'proof' });
    publish([{ name: 'skill:draw-avatar' }, { name: '/draw-avatar' }, { name: '/skill:draw-avatar' }, { name: 'review' }]);
    expect(execute).toHaveBeenCalledWith('postAgentCommands', {
      agentId: 'grunt', workspaceId: 'proof', commands: [{ name: 'review' }, DRAW_AVATAR_COMMAND],
    });
  });

  it('hides the exact managed rule skills while preserving owner skills and command names', () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const managed = beelineManagedSkills('proof', { isReviewer: true, freeAgent: false });
    const retained = [{ name: 'skill:beeline-custom' }, { name: 'skill:paint', description: 'Owner skill' }, { name: 'paint' }];
    agentCommandCatalogPublisher({ api: { execute } as unknown as DaemonApiClient, agentId: 'grunt', workspaceId: 'proof' })([
      ...managed.flatMap(({ name }) => [{ name }, { name: `skill:${name}` }, { name: `/skill:${name}` }]), ...retained,
    ]);
    expect(execute.mock.calls[0][1].commands).toEqual([...retained, DRAW_AVATAR_COMMAND]);
  });
});
