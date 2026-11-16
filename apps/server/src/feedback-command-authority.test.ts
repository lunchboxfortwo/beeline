import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { callAgentTool } from '../../body/src/read-only-mcp-open-poll.js';
import { createAgentCommand } from './agent-command.js';
import { TokenAuth, tokenHash } from './auth.js';
import { DaemonService } from './daemon-service.js';
import * as daemonWorkbench from './daemon/workbench.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { migratedDatabase } from './test-support.js';

it('report_feedback stores external and Beeline workspace reports even when task command authority is unavailable', async () => {
  const db = await migratedDatabase();
  const scratch = await mkdtemp(join(tmpdir(), 'feedback-authority-'));
  const contextFile = join(scratch, 'turn.json');
  const owner = 'a'.repeat(64);
  const live = new LiveHub();
  const daemon = new DaemonService(db, live);
  vi.spyOn(daemonWorkbench, 'daemonWarmConnectorIndex').mockResolvedValue();
  const server = createBeelineServer({ database: db, daemon, live,
    auth: new TokenAuth(db, async () => { throw new Error('unused'); }),
    phone: new PhoneService(db, 'http://test'), mediaMaximumBytes: 1 });
  try {
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`, [owner]);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    vi.stubEnv('BEELINE_DAEMON_BASE_URL', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', contextFile);
    for (const [index, workspaceName] of ['Milo workspace', 'Beeline workspace'].entries()) {
      const workspace = randomUUID(), room = randomUUID(), agent = String(index + 1).repeat(64);
      const token = `bdt_feedback_authority_proof_${index}`;
      await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Reporter')`, [agent]);
      await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, owner]);
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,$2)`, [workspace, workspaceName]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Chat')`, [room, workspace]);
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,NULL,$3,'member'),($1,$2,$3,'member'),($1,NULL,$4,'owner'),($1,$2,$4,'owner')`,
      [workspace, room, agent, owner]);
      await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash(token), agent]);
      vi.stubEnv('BEELINE_DAEMON_TOKEN', token);
      vi.stubEnv('BEELINE_DAEMON_AGENT_ID', agent);
      vi.stubEnv('BEELINE_DAEMON_ROOM_ID', room);
      const source = String(index + 3).repeat(64);
      await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Please investigate')`, [source, room, owner]);
      const command = await createAgentCommand(db, { roomId: room, agentId: agent, sourceMessageId: source, reason: 'human_tag' });
      for (const [label, requestId] of [['known', command!.turn_request_id], ['unavailable', 'missing-command'], ['cancelled', command!.turn_request_id]] as const) {
        if (label === 'cancelled') await db.query(`UPDATE agent_commands SET state='cancelled' WHERE id=$1`, [command!.id]);
        await writeFile(contextFile, JSON.stringify({ roomId: room, requestId, promptSectionIds: ['core.identity'] }));
        const summary = `${workspaceName}: ${label} task authority`;
        const result = JSON.parse(await callAgentTool('report_feedback', { category: 'bug', summary }, 'proof'));
        expect(result).toEqual({ itemId: expect.stringMatching(/^fb_/) });
        expect((await db.query(`SELECT reporter_identity_id,reporter_owner_id,workspace_id,room_id,
          request_id,trigger_message_id,summary,prompt_section_ids FROM feedback_items WHERE id=$1`, [result.itemId])).rows)
          .toEqual([{ reporter_identity_id: agent, reporter_owner_id: owner, workspace_id: workspace,
            room_id: room, request_id: requestId, trigger_message_id: label === 'unavailable' ? null : source,
            summary, prompt_section_ids: ['core.identity'] }]);
      }
    }
  } finally {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
    await rm(scratch, { recursive: true, force: true });
  }
}, 60_000);
