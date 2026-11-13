import { HELPER_UPDATE_CLOSE_CODE,HELPER_UPDATE_CLOSE_REASON,wall } from '@beeline/api-contract/daemon';
import type { Socket } from 'node:net';
import type { WebSocket } from 'ws';
import { DaemonAgentSession,type DaemonLiveDependencies } from './daemon-live.js';
import { cachedSentryAccount,noteSentryUser,rememberSentryAccount,withSentryAgent } from './sentry.js';
export const MACHINE_SOCKET_PROTOCOL = 'beeline.machine.1';
type SendLive = (payload: string) => void;

function frameBytes(raw: Buffer | ArrayBuffer | Buffer[]): number {
  return Array.isArray(raw) ? raw.reduce((total, part) => total + part.length, 0) : raw.byteLength;
}

function parseFrame(raw: Buffer | ArrayBuffer | Buffer[]): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(
      Array.isArray(raw) ? Buffer.concat(raw).toString() : Buffer.from(raw as ArrayBuffer).toString(),
    ) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A pre-machine helper: one socket authenticated as one agent at upgrade.
 * It is one session; the socket's frames carry no agent id.
 */
export function serveAgentSocket(
  deps: DaemonLiveDependencies,
  client: WebSocket,
  principal: { identityId: string; helperVersion?: string; helperSourceSha?: string },
  sendLive: SendLive,
  trackSubscriptions: (count: () => number) => void,
): void {
  const isOpen = () => client.readyState === client.OPEN;
  const send = (event: Record<string, unknown>) => {
    if (isOpen()) sendLive(JSON.stringify(event));
  };
  sendLive(JSON.stringify({
    type: 'hello',
    protocolMin: 1,
    protocolMax: 1,
    capabilities: { discoveryWake: true, pushIntake: true },
    ...(principal.helperVersion ? { reportedHelper: {
      releaseVersion: principal.helperVersion,
      ...(principal.helperSourceSha ? { sourceSha: principal.helperSourceSha } : {}),
    } } : {}),
  }));
  const session = new DaemonAgentSession(deps, principal.identityId, {
    send,
    isOpen,
    drop: (code, reason) => {
      // A newer connection replaced this socket: it holds nothing worth a
      // graceful close, and its count was already released at upgrade.
      if (code === 4001) client.terminate();
      else if (isOpen()) client.close(code, reason);
    },
  });
  void session.claim();
  trackSubscriptions(() => session.subscriptions);
  const releaseSubscription = deps.releaseNotify?.subscribeHelperRelease((release) =>
    send({ type: 'helper-release', version: release.version, sha: release.sha }),
  );
  client.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const bytes = frameBytes(raw);
    const item = parseFrame(raw);
    if (!item) {
      deps.errors.invalid++;
      return;
    }
    withSentryAgent(deps.database, principal.identityId, () => session.frame(item, bytes));
  });
  client.on('close', (code, reason) => {
    releaseSubscription?.();
    session.close(code === HELPER_UPDATE_CLOSE_CODE && reason.toString() === HELPER_UPDATE_CLOSE_REASON);
  });
}

/**
 * One socket for every agent on a helper machine. The socket itself carries no
 * identity: each agent registers with its own daemon token, and a refused,
 * revoked or overloaded agent loses only its own registration.
 */
export function serveMachineSocket(
  deps: DaemonLiveDependencies,
  client: WebSocket,
  principal: { helperVersion?: string; helperSourceSha?: string },
  sendLive: SendLive,
  trackSubscriptions: (count: () => number) => void,
): void {
  const sessions = new Map<string, DaemonAgentSession>();
  const isOpen = () => client.readyState === client.OPEN;
  const send = (event: Record<string, unknown>) => {
    if (isOpen()) sendLive(JSON.stringify(event));
  };
  trackSubscriptions(() => [...sessions.values()].reduce((sum, session) => sum + session.subscriptions, 0));
  send({
    type: 'hello',
    protocol: 'machine',
    protocolMin: 1,
    protocolMax: 1,
    capabilities: { discoveryWake: true, pushIntake: true },
    ...(principal.helperVersion ? { reportedHelper: {
      releaseVersion: principal.helperVersion,
      ...(principal.helperSourceSha ? { sourceSha: principal.helperSourceSha } : {}),
    } } : {}),
  });
  const releaseSubscription = deps.releaseNotify?.subscribeHelperRelease((release) =>
    send({ type: 'helper-release', version: release.version, sha: release.sha }),
  );
  const unregistered = (agentId: string, reason: string, code?: number) =>
    send({ type: 'unregistered', agentId, reason, ...(code ? { code } : {}) });

  const register = (item: Record<string, unknown>, reply = send) =>
    typeof item.agentId === 'string' ? withSentryAgent(deps.database, item.agentId, () => registerAgent(item, reply)) : registerAgent(item, reply);
  const registerAgent = async (item: Record<string, unknown>, reply = send) => {
    const agentId = item.agentId;
    const token = item.token;
    if (typeof agentId !== 'string' || !/^[0-9a-f]{64}$/i.test(agentId)) {
      deps.errors.invalid++;
      return;
    }
    const registrationStartedAt = Date.now();
    let registrationStage = 'authentication';
    try {
      const authenticated = typeof token === 'string' && token.startsWith('bdt_')
        ? await deps.auth.authenticateDaemon(token) : undefined;
      if (!isOpen()) return;
      if (authenticated !== agentId) {
        // The same two answers HTTP gives: a settled removal, or a token to retry.
        registrationStage = 'retirement-check';
        const retired = authenticated ? null : typeof token === 'string' ? await deps.auth.retiredDaemonAgent(token) : null;
        reply({
          type: 'register-refused',
          agentId,
          code: wall('credentials', retired ? 'agent_removed' : 'daemon_token_required').message,
        });
        return;
      }
      registrationStage = 'session-setup';
      sessions.get(agentId)?.close();
      const session: DaemonAgentSession = new DaemonAgentSession(
        deps,
        agentId,
        {
          send: (event) => send({ ...event, agentId }),
          isOpen: (): boolean => isOpen() && sessions.get(agentId) === session,
          drop: (code, reason) => {
            if (sessions.get(agentId) !== session) return;
            sessions.delete(agentId);
            unregistered(agentId, reason, code);
          },

        },
        {
          ...(typeof item.lifecycleId === 'string'
            ? { lifecycleId: item.lifecycleId } : {}),
          ...(typeof item.releaseVersion === 'string' ? { releaseVersion: item.releaseVersion } : {}),
          ...(typeof item.sourceSha === 'string' ? { sourceSha: item.sourceSha } : {}),
          ...(typeof item.available === 'boolean' ? { available: item.available } : {}),
          ...(item.overlayV1===true?{overlayV1:true}:{}),
          ...(item.usageAccountV1===true?{usageAccountV1:true}:{}),
          ...(item.queueV1===true?{queueV1:true}:{}),
          ...(item.daemonOperationsV1===true?{daemonOperationsV1:true}:{}),
        },
      );
      sessions.set(agentId, session);
      registrationStage = 'presence-claim';
      await session.claim();
      if (session.closed || sessions.get(agentId) !== session) return;
      // The helper names this account on its own error reports. Telemetry never refuses registration.
      const ownerId = session.usageOwnerId ?? (cachedSentryAccount(agentId) !== agentId ? cachedSentryAccount(agentId) : undefined);
      if (ownerId) { rememberSentryAccount(agentId, ownerId); noteSentryUser(ownerId); }
      if (session.closed || sessions.get(agentId) !== session) return;
      reply({
        type: 'registered',
        agentId,
        capabilities: { initialSnapshotsV1: true, discoveryWake: true, pushIntake: true,
          ...(item.daemonOperationsV1 === true ? {daemonOperationsV1:true} : {}),
          ...(item.queueV1 === true ? {queueV1:true} : {}),
          ...(ownerId ? {ownerId} : {}),
          ...(session.overlayV1?{overlayV1:true}:{}),
          ...(session.usageAccountV1?{usageAccountV1:true,usageOwnerId:session.usageOwnerId,usageConnectionId:session.connectionId,usageConnectionEpoch:session.epoch}:{}) },
      });
    } catch (error) {
      deps.errors.internal++;
      console.error('[live] agent registration failed', JSON.stringify({
        agentId, stage: registrationStage, elapsedMs: Date.now() - registrationStartedAt,
        helperSourceSha: principal.helperSourceSha,
      }), error instanceof Error ? error.message : String(error));
      if (isOpen()) reply({ type: 'register-refused', agentId, code: 'registration_failed' });
    }
  };

  client.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const bytes = frameBytes(raw);
    const item = parseFrame(raw);
    if (!item) {
      deps.errors.invalid++;
      return;
    }
    if (item.type === 'register-machine' && Array.isArray(item.agents)) {
      for (const agent of item.agents)
        if (agent && typeof agent === 'object') void register(agent);
      return;
    }
    if (item.type === 'register') {
      void register(item);
      return;
    }
    const agentId = typeof item.agentId === 'string' ? item.agentId : undefined;
    const session = agentId ? sessions.get(agentId) : undefined;
    if (!session) {
      deps.errors.invalid++;
      return;
    }
    if (item.type === 'unregister') {
      sessions.delete(session.agentId);
      session.close();
      return;
    }
    withSentryAgent(deps.database, session.agentId, () => session.frame(item, bytes));
  });
  client.on('close', (code, reason) => {
    releaseSubscription?.();
    const forUpdate = code === HELPER_UPDATE_CLOSE_CODE && reason.toString() === HELPER_UPDATE_CLOSE_REASON;
    for (const session of sessions.values()) session.close(forUpdate);
    sessions.clear();
  });
}

/** A live machine receives every queue/result frame. Durable items survive disconnect. */
export function machineConnectionOutput(client: WebSocket): (payload: string) => boolean {
  return payload => {
    const open = client.readyState === client.OPEN;
    if (open) client.send(payload);
    return open;
  };
}

/** Both peers use kernel keepalive; no application ping/pong work is armed. */
export function enableMachineTcpKeepalive(socket:Socket):void { socket.setKeepAlive(true,30_000); }
