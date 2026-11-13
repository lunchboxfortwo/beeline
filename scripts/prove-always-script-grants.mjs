// Isolated built-service proof. Never starts a helper or touches production services.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { migratedDatabase } from '../apps/server/src/test-support.ts';
import { HelperDaemonService } from '../apps/server/dist/test-fixtures/helper-daemon.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { GrantCommandRunner, GrantRunnerServer } from '../apps/body/dist/grant-runner.js';
import { requestGrant } from '../apps/body/dist/read-only-mcp-agent-grant-deps.js';

const db = await migratedDatabase();
const root = mkdtempSync('/tmp/beeline-script-grants-');
const owner = 'a'.repeat(64), agent = 'b'.repeat(64);
const workspace = randomUUID(), room = randomUUID();
const live = new LiveHub(), daemon = new HelperDaemonService(db, live), phone = new PhoneService(db, live);
let runnerServer;
try {
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Proof','proof')`, [owner, agent]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agent, owner]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Proof')", [workspace]);
  await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Proof')", [room, workspace]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$3,'owner'),($1,NULL,$4,'member'),($1,$2,$3,'owner'),($1,$2,$4,'member')`, [workspace, room, owner, agent]);
  await phone.sendMessage({ roomId: room, text: '@proof demonstrate approval reuse', mentions: [agent] }, owner);
  const [command] = (await daemon.execute('getAgentCommands', { roomId: room }, agent)).commands;
  await daemon.execute('claimAgentCommand', { roomId: room, commandId: command.id, generationId: 'proof' }, agent);
  const authority = { roomId: room, requestId: command.turnRequestId, generationId: 'proof' };
  const execute = (operation, input) => daemon.execute(operation, { ...input, ...authority, agentId: agent }, agent);
  const deps = { roomId: room, scriptRoots: [root], scriptEnv: { PATH: '/usr/bin:/bin' }, execute };
  const cases = [
    ['python3', 'fix.py'],
    ['bash', '-c', 'printf approved'],
    ['python3', '-c', 'print("approved")'],
    ['node', '-e', 'console.log("approved")'],
    ['bash', '-c', "python3 <<'PY'\nprint('approved')\nPY"],
    { argv: ['bash', '-s'], stdin: 'printf approved' },
    ['proof-task'],
    ['echo', 'approved'],
  ];
  writeFileSync(resolve(root, 'proof-task'), '#!/bin/sh\nprintf approved', { mode: 0o755 });
  writeFileSync(resolve(root, 'fix.py'), 'print("approved")');
  deps.scriptEnv.PATH = `${root}:/usr/bin:/bin`;
  const runner = new GrantCommandRunner({ agentId: agent, env: { PATH: deps.scriptEnv.PATH, HOME: root }, api: { execute } });
  runner.register(room, { workspaceId: workspace, cwd: root, turn: () => ({ requestId: authority.requestId, generationId: 'proof' }), writePolicy: () => ({ surface: 'corner' }) });
  runnerServer = new GrantRunnerServer(runner);
  const endpoint = await runnerServer.start();
  for (const value of cases) {
    const argv = Array.isArray(value) ? value : value.argv;
    const target = JSON.stringify(value);
    const text = await requestGrant({ kind: 'command', target, reason: 'Isolated proof', purpose: 'Demonstrate script approvals' }, deps);
    const rows = await db.query('SELECT id,status,script FROM agent_grants WHERE agent_id=$1 AND target=$2 ORDER BY created_at DESC', [agent, target]);
    const grant = rows.rows[0];
    const systemTool = argv[0] === 'echo';
    assert.equal(grant.status, systemTool ? 'approved' : 'pending', text);
    if (!systemTool) {
      const cards = (await db.query("SELECT room_id FROM messages WHERE card_type='grant-request' ORDER BY created_at DESC LIMIT 1")).rows;
      const view = await phone.readRoom(cards[0].room_id, owner);
      assert.ok(JSON.stringify(view).includes(JSON.stringify(grant.script.contents).slice(1, -1)), 'phone read must contain the exact script bytes');
      assert.equal(grant.script.contents, argv[0] === 'proof-task' ? '#!/bin/sh\nprintf approved' : argv[1] === 'fix.py' ? 'print("approved")' : Array.isArray(value) ? argv[2] : value.stdin);
      await phone.decideAgentGrant({ grantId: grant.id, decision: 'always' }, owner);
      const pending = (await daemon.execute('getAgentCommands', { roomId: room }, agent)).commands;
      assert.ok(pending.length, 'Always must queue an approval resume');
      const resumed = pending.find(command => command.state === 'pending') ?? pending[0];
      await daemon.execute('claimAgentCommand', { roomId: room, commandId: resumed.id, generationId: 'proof' }, agent);
      authority.requestId = resumed.turnRequestId;
    }
    const repeated = await requestGrant({ kind: 'command', target, reason: 'Repeat', purpose: 'Reuse Always approval' }, deps);
    assert.match(repeated, new RegExp(`approved:.*${grant.id}`));
    assert.equal((await db.query('SELECT id FROM agent_grants WHERE agent_id=$1 AND target=$2', [agent, target])).rowCount, 1);
    for (let run = 0; run < 2; run++) {
      const response = await fetch(`${endpoint.url}/run`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ roomId: room, argv, ...(Array.isArray(value) ? {} : { stdin: value.stdin }) }) });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.exitCode, 0, result.output);
      assert.match(result.output, /approved/);
    }
    if (argv[0] === 'node') {
      for (const option of ['--import=data:text/javascript,console.log("unreviewed")', '--require=unreviewed']) {
        const response = await fetch(`${endpoint.url}/run`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ roomId: room, argv: [...argv, option] }) });
        assert.notEqual(response.status, 200);
        assert.match(JSON.stringify(await response.json()), /code-loading options/);
      }
      console.log('PASS R-SCRIPT-2: extra Node code loaders refused before execution');
    }
    console.log(`PASS R-ALWAYS-1 / R-SCRIPT-1: ${argv[0]} ${argv[1] ?? ''}: ${systemTool ? 'no script card' : 'exact card bytes'}, one grant, repeated request and two successful executions`);
  }
  for (const name of ['python3', 'node', 'env', 'timeout']) {
    const contents = '#!/bin/sh\nprintf unreviewed';
    writeFileSync(resolve(root, name), contents, { mode: 0o755 });
    const argv = [name, '--version'];
    const target = JSON.stringify(argv);
    const text = await requestGrant({ kind: 'command', target, reason: 'Shadow proof', purpose: 'Show writable executable bytes' }, deps);
    const grant = (await db.query('SELECT status,script FROM agent_grants WHERE agent_id=$1 AND target=$2', [agent, target])).rows[0];
    assert.equal(grant.status, 'pending', text);
    assert.equal(grant.script.contents, contents);
    const response = await fetch(`${endpoint.url}/run`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ roomId: room, argv }) });
    assert.notEqual(response.status, 200);
    assert.ok(!JSON.stringify(await response.json()).includes('printf unreviewed'));
    console.log(`PASS R-SCRIPT-2: writable PATH ${name} --version has exact script card and cannot run unapproved`);
  }

} finally {
  await runnerServer?.close();
  await db.close();
  rmSync(root, { recursive: true, force: true });
}
