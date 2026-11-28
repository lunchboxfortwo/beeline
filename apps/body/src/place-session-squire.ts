import { homedir } from 'node:os';
import type { DaemonApiClient } from './daemon-api-client.js';
import { resourceCallFacts } from './resource-mcp-facade.js';
import { SquireTaskRelay } from './squire-task-relay.js';

export function createPlaceSquireRelay(
  api: DaemonApiClient,
  agentId: string,
  roomId: string,
  operatorHome?: string,
): SquireTaskRelay {
  const logged = (label: string) => (error: unknown) => console.error(`[body] ${label}:`, error);
  return new SquireTaskRelay(
    agentId,
    roomId,
    async (call) =>
      (
        await api.execute('authorizeResourceCall', {
          roomId: call.roomId,
          requestId: call.requestId,
          target: 'squire',
          ...resourceCallFacts({ method: 'tools/call', params: { name: call.tool } }),
        })
      ).allowed === true,
    operatorHome ?? homedir(),
    undefined,
    (decision) => {
      void api
        .execute('postSquireApprovalDecision', { roomId, ...decision })
        .catch(logged('Squire approval decision not published'));
    },
    (sessionId) => {
      void api
        .execute('endComputerSession', { roomId, sessionId })
        .catch(logged('Squire session end not published'));
    },
    async (lease) => (await api.execute('refreshComputerSession', { roomId, ...lease })).live,
    (url, siteUrl) => {
      void api
        .execute('forgetSquireSignIn', { url, ...(siteUrl ? { siteUrl } : {}) })
        .catch(logged('Squire sign-in removal failed'));
    },
    async (service) =>
      (await api.execute('readAgentWorkbench', { roomId })).apps?.find(
        (app) =>
          app.appKey === service.trim().toLowerCase() &&
          app.transport === 'squire-api' &&
          app.status === 'connected',
      )?.connectionReference,
    () => api.refreshMachineVault(),
  );
}
