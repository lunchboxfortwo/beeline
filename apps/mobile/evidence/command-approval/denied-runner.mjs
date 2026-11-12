import { GrantCommandRunner } from '../../../body/dist/grant-runner.js';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const cwd = await mkdtemp(join(tmpdir(), 'beeline-denied-command-'));
try {
  const marker = join(cwd, 'ran');
  await writeFile(join(cwd, 'checks.py'), 'open("ran", "w").write("executed")\n');
  // Establish that executing this exact script really creates the marker.
  await promisify(execFile)('python3', ['checks.py'], { cwd });
  await access(marker);
  await rm(marker);

  const calls = [];
  const runner = new GrantCommandRunner({
    agentId: 'b'.repeat(64),
    resolveSecret: async () => undefined,
    api: {
      execute: async (name) => {
        calls.push(name);
        if (name === 'listTurnAgentGrants') return { grants: [] };
        if (name === 'listAgentGrantRequests') return {
          grants: [{ grantId: 'denied-command', workspaceId: 'workspace', roomId: 'room',
            kind: 'command', target: 'python3 checks.py', status: 'denied' }],
        };
        throw new Error('Unexpected execution operation: ' + name);
      },
    },
  });
  runner.register('room', {
    workspaceId: 'workspace', cwd,
    writePolicy: () => ({ surface: 'corner' }),
    turn: () => ({ requestId: 'request', generationId: 'generation' }),
  });
  let refusal = '';
  try {
    await runner.run({ roomId: 'room', argv: ['python3', 'checks.py'] });
  } catch (error) {
    refusal = String(error);
  }
  if (!refusal.includes('no approved command grant matches'))
    throw new Error('Missing grant refusal: ' + refusal);
  let ran = false;
  try { await access(marker); ran = true; } catch {}
  if (ran) throw new Error('Denied command executed');
  console.log(JSON.stringify({ reproduction: 'COMMAND-APPROVAL-1',
    positiveControlCreatedMarker: true, refusal,
    executionSideEffect: false, operations: calls }, null, 2));
} finally {
  await rm(cwd, { recursive: true, force: true });
}
