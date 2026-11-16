import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { transform } from 'esbuild';

// Reproduction handle-1 uses isolated PostgreSQL-compatible storage; no Fly calls.
const evidence = new URL('../../.beeline-proof/handles/', import.meta.url);
await mkdir(evidence, { recursive: true });
if (process.argv.includes('--before')) {
  const baseline = execFileSync('git', ['show', '074b6c186:apps/server/src/free-agents.ts'], { encoding: 'utf8' });
  await writeFile(new URL('../../apps/server/dist/free-agents-baseline.js', import.meta.url),
    (await transform(baseline, { loader: 'ts', format: 'esm', target: 'es2022' })).code);
}
import { PgliteDatabase } from '../../apps/server/src/test-support.ts';
import { migrate } from '../../apps/server/dist/database.js';
import { PhoneService } from '../../apps/server/dist/phone-service.js';
const { FreeAgentService } = await import(process.argv.includes('--before') ? '../../apps/server/dist/free-agents-baseline.js' : '../../apps/server/dist/free-agents.js');
const db = new PgliteDatabase();
try {
  await migrate(db);
  const owner = 'a'.repeat(64), friend = 'b'.repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'human','Friend','friend')`,[owner,friend]);
  const machines = new Proxy({}, {get: (_,method) => async () => { throw new Error(`Unexpected provisioning: ${String(method)}`); }});
  const agents = new FreeAgentService(db,{model:'fixture',maxPerOwner:6,dailyTokenCap:1000,firstDayTokenCap:1000,lifetimeTokenCap:3000,sealSecret:'isolated-fixture',publicOrigin:'http://localhost',image:'fixture',region:'iad',cpus:1,memoryMb:1024},machines,async () => ({exchangeToken:'fixture'}),() => {});
  const phone = new PhoneService(db,'http://localhost');
  phone.setFreeAgents(agents);
  const result=[];
  for (const [name,person] of [['One',owner],['Two',friend]]) {
    const workspace = await phone.execute('createWorkspace',{name},person);
    const roster = await phone.readWorkspaceMembers(workspace.id,person);
    if (!process.argv.includes('--before')) assert.deepEqual(roster.agents.map(agent => agent.identity.handle).sort(),['beebee','luna']);
    result.push({workspace:name,roster});
    if (process.argv.includes('--before')) {
      assert.deepEqual(roster.agents.map(agent => agent.identity.handle).sort(),
        name === 'One' ? ['beebee','luna'] : ['beebee_2','luna_2']);
      continue;
    }
    const luna = roster.agents.find(agent => agent.identity.handle==='luna').identity;
    const sent = await phone.sendMessage({roomId:workspace.roomId,text:'@luna hello'},person);
    const command = await db.query(`SELECT agent_id FROM agent_commands WHERE source_message_id=$1 AND reason='human_tag'`,[sent.messageId]);
    assert.deepEqual(command.rows.map(row => row.agent_id),[luna.pubkey]);
    const view = await phone.readRoom(workspace.roomId,person);
    assert.equal(view.messages.find(message => message.id===sent.messageId).mentionPubkeys[0],luna.pubkey);
    result.push({workspace:name,handles:roster.agents.map(agent => agent.identity.handle),tag:'@luna',deliveredTo:luna.pubkey});
  }
  await writeFile(new URL(process.argv.includes('--before') ? 'before.json' : 'after.json',evidence),JSON.stringify({reproduction:'handle-1',result},null,2));
  console.log(process.argv.includes('--before')
    ? 'Reproduced handle-1: second workspace uses globally numbered starter handles'
    : 'Demonstrated handle-1: built workspace creation -> member list with plain handles -> @luna send -> local command -> phone transcript highlight');
} finally { await db.close(); }
