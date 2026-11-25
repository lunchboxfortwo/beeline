import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parseCommandGrantTarget } from '@beeline/api-contract/agent-grants';
import { GrantCommandRunner, GrantRunnerServer } from './grant-runner.js';
import { readGrantScript } from './read-only-mcp-agent-grant-deps.js';
import { sessionCommandContext, sessionToolRequest } from './session-tool-connection.js';
import type { GrantOutputLine } from './grant-runner-output.js';

afterEach(() => vi.unstubAllEnvs());

it('lets only the current reset generation read the live command for a place', async () => {
  let resetId: string | undefined;
  const context = { roomId: 'place', requestId: 'owed' };
  const server = new GrantRunnerServer(
    {} as GrantCommandRunner,
    undefined,
    async () => context,
    (placeId, observedReset) => placeId === 'place' && observedReset === resetId,
  );
  const endpoint = await server.start();
  const environment = { BEELINE_GRANT_RUNNER_URL: endpoint.url, BEELINE_GRANT_RUNNER_TOKEN: endpoint.token };
  try {
    await expect(sessionCommandContext(undefined, 'place', environment)).resolves.toEqual(context);
    resetId = 'a'.repeat(64);
    await expect(sessionCommandContext(undefined, 'place', environment)).rejects.toThrow('this daemon is not serving that chat');
    await expect(sessionCommandContext(undefined, 'place', { ...environment, BEELINE_PLACE_RESET_ID: resetId }))
      .resolves.toEqual(context);
  } finally {
    await server.close();
  }
});

it.each(['single-line-secret', 'ABCD\nxy'])(
  'streams redacted command output before exit and preserves the result (%s)',
  async (secret) => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-command-stream-'));
    const script = `const fs=require('node:fs');const bytes=Buffer.from('🐝 '+process.env.TOKEN+'\\n');
let finished=false;const watcher=fs.watch(${JSON.stringify(root)},(_event,name)=>{if(name==='release'&&!finished){
  finished=true;watcher.close();process.stdout.write(bytes.subarray(2));process.stderr.write('done\\n');process.exitCode=7;
}});process.stdout.write(bytes.subarray(0,2));process.stderr.write('waiting\\n');`;
    const argv = ['node', '-e', script];
    // A JSON command target carries no secrets; the run requests TOKEN under its own live secret grant.
    const target = JSON.stringify({ argv });
    const grant = {
      grantId: 'approved',
      workspaceId: 'workspace',
      kind: 'command',
      target,
      status: 'approved',
      requestedBy: 'owner',
      script: readGrantScript(parseCommandGrantTarget(target), {
        roomId: 'room',
        scriptRoots: [root],
        scriptEnv: { PATH: process.env.PATH },
        execute: async () => ({}),
      }),
    };
    const runner = new GrantCommandRunner({
      agentId: 'agent',
      env: { PATH: process.env.PATH, HOME: root },
      resolveSecret: async () => secret,
      api: {
        execute: async (name: string) =>
          name === 'listTurnAgentGrants'
            ? {
                grants: [
                  grant,
                  {
                    grantId: 'secret',
                    workspaceId: 'workspace',
                    roomId: 'room',
                    kind: 'secret',
                    target: 'TOKEN',
                    status: 'approved',
                    requestedBy: 'owner',
                  },
                ],
              }
            : {},
      } as never,
    });
    runner.register('room', {
      workspaceId: 'workspace',
      cwd: root,
      turn: () => ({ requestId: 'request' }),
      writePolicy: () => ({ surface: 'corner' }),
    });
    const server = new GrantRunnerServer(runner);
    const endpoint = await server.start();
    vi.stubEnv('BEELINE_GRANT_RUNNER_FILE', '');
    vi.stubEnv('BEELINE_GRANT_RUNNER_URL', endpoint.url);
    vi.stubEnv('BEELINE_GRANT_RUNNER_TOKEN', endpoint.token);
    const lines: GrantOutputLine[] = [];
    let progress!: () => void;
    const progressing = new Promise<void>((done) => {
      progress = done;
    });
    let settled = false;
    const work = sessionToolRequest(
      '/run',
      { roomId: 'room', argv, secrets: ['TOKEN'] },
      (line) => {
        lines.push(line);
        if (line.text === 'waiting\n') progress();
      },
    ).then((value) => {
      settled = true;
      return value;
    });
    try {
      await progressing;
      expect(settled).toBe(false);
      expect(lines).toEqual([{ stream: 'stderr', text: 'waiting\n' }]);
      await writeFile(join(root, 'release'), '');
      expect(await work).toMatchObject({
        grantId: 'approved',
        exitCode: 7,
        timedOut: false,
        output: '🐝 [TOKEN]\n\nwaiting\ndone\n',
      });
      expect(lines.map((line) => line.text).join('')).toContain('🐝 [TOKEN]');
      expect(lines.map((line) => line.text).join('')).not.toContain('�');
      for (const part of secret.split('\n'))
        expect(lines.map((line) => line.text).join('')).not.toContain(part);
    } finally {
      await writeFile(join(root, 'release'), '');
      await work.catch(() => undefined);
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(['/session', '/workspace'])(
  'sends response headers while %s work is still pending',
  async (route) => {
    let release!: () => void;
    const pending = new Promise<void>((done) => {
      release = done;
    });
    const server = new GrantRunnerServer(
      {} as GrantCommandRunner,
      async () => {
        await pending;
        return 'ready';
      },
      async () => {
        await pending;
        return { ready: true };
      },
    );
    const endpoint = await server.start();
    try {
      const response = await fetch(`${endpoint.url}${route}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ placeId: 'place' }),
      });
      expect(response.headers.get('content-type')).toBe('application/x-ndjson');
      release();
      expect(JSON.parse((await response.text()).trim())).toEqual({
        type: 'result',
        status: 200,
        value: route === '/workspace' ? { text: 'ready' } : { ready: true },
      });
    } finally {
      release();
      await server.close();
    }
  },
);
