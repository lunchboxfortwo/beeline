import { startQueuedTurn } from './test-fixtures/queued-turn.test-support.js';
import * as daemonWorkbench from './daemon/workbench.js';
import type { AddressInfo } from 'node:net';
import { captureException } from '@sentry/node';
import { expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase, describedWorkflow } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { TokenAuth, tokenHash } from './auth.js';
import { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { createAgentCommand } from './agent-command.js';

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));
vi.spyOn(daemonWorkbench, 'daemonWarmConnectorIndex').mockResolvedValue();

const TOKEN = 'bdt_workflow_refusal_sentry_123456';

it('Reproduction SERVER-4K: workflow unavailable and already-ended refusals stay out of Sentry', async () => {
  const db = new PgliteDatabase();
  const owner = 'a'.repeat(64), agent = 'b'.repeat(64), source = 'c'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111';
  const room = '22222222-2222-4222-8222-222222222222';
  const live = new LiveHub();
  const daemon = new DaemonService(db, live);
  const server = createBeelineServer({
    database: db, daemon, live,
    auth: new TokenAuth(db, async () => { throw new Error('unused'); }),
    phone: new PhoneService(db, 'http://test'), mediaMaximumBytes: 1,
  });
  try {
    await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Agent')`, [owner, agent]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, owner]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Refusal proof')`, [workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,identity_id,role)
      VALUES($1,$2,'owner'),($1,$3,'member')`, [workspace,owner,agent]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [room, workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member'),($1,$2,$4,'owner')`, [workspace, room, agent, owner]);
    await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash(TOKEN), agent]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Start the feedback sweep')`, [source, room, owner]);
    const command = await createAgentCommand(db, { roomId: room, agentId: agent, sourceMessageId: source, reason: 'human_tag' });
    await startQueuedTurn(db, room, agent, command!.id);
    const turn = { roomId: room, requestId: command!.turn_request_id };
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (operation: string, input: unknown) => {
      const response = await fetch(`${origin}/v1/daemon/operations/${operation}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const expectRefusal = async (operation: string, input: unknown, message: string) => {
      vi.mocked(captureException).mockClear();
      const result = await post(operation, input);
      expect(result).toEqual({ status: 503, body: { error: message } });
      expect(captureException).not.toHaveBeenCalled();
    };

    await expectRefusal('startWorkflow', { ...turn, name: 'feedback-sweep', roleBindings: { worker: agent } }, 'workflow is unavailable');

    expect((await post('saveWorkflow', { ...turn, contract: describedWorkflow({
      version: 1, name: 'feedback-sweep', description: 'Daily feedback sweep', roles: ['worker'], start: 'sweep',
      handoffs: {
        sweep: { role: 'worker', requires: [], on: { finished: 'done' } },
        done: { kind: 'terminal', status: 'done' },
      },
    }) })).status).toBe(200);
    const started = await post('startWorkflow', { ...turn, name: 'feedback-sweep', roleBindings: { worker: agent } });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const finished = await post('handoff', { ...turn, runId: started.body.runId, outcome: 'finished', contents: {} });
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);
    const ended = { ...turn, runId: started.body.runId };
    await expectRefusal('handoff', { ...ended, outcome: 'finished', contents: {}, attempt: finished.body.attempt }, 'this workflow run has already ended');
    await expectRefusal('cancelWorkflowRun', { ...ended, reason: 'Again' }, 'this workflow run has already ended');
    await expectRefusal('assignWorkflowRole', { ...ended, role: 'worker', targetAgentId: agent }, 'this workflow run has already ended');

    const fault = new Error('Unexpected workflow fault');
    vi.mocked(captureException).mockClear();
    vi.spyOn(daemon, 'execute').mockRejectedValueOnce(fault);
    expect((await post('startWorkflow', { ...turn, name: 'feedback-sweep', roleBindings: { worker: agent } })).status).toBe(503);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(fault, expect.anything());
  } finally {
    vi.restoreAllMocks();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
  }
}, 60_000);
