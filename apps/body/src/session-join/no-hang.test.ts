// Each test reproduces a session-join wait that used to hang, and proves it now settles on its own answer or on
// the channel's explicit failure event.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:net';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ensureBridge, toolViaBridge } from './bridge.js';

import { bridgeOwnerKey, bridgeSocketPath } from './bridge-socket.js';
import { runSessionCommand } from './command.js';
import { fill, HERMES_PLUGIN, OPENCODE_PLUGIN, PI_EXTENSION } from './templates.js';
import { queueInbox, stateDir, updateState, type JoinedSession } from './store.js';

const folders: string[] = [];
const children: ChildProcess[] = [];
const scratch = (prefix = 'beeline-no-hang-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  folders.push(dir);
  return dir;
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tsImport = createRequire(import.meta.url).resolve('tsx/esm/api');
const waitModule = resolve('src/wait.ts');

/** A node entry that runs TypeScript from this tree, as the copied bundle runs in a real session. */
function entry(dir: string, body: string): string {
  const file = join(dir, 'usebeeline.mjs');
  writeFileSync(file, `import { tsImport } from ${JSON.stringify(tsImport)};\n${body}\n`);
  return file;
}

/** A separate process holding a kernel lock, as a bridge or sign-in finisher does. */
async function holdLock(key: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { tryLock } from ${JSON.stringify(waitModule)};
       const lock = await tryLock(${JSON.stringify(key)});
       process.stdout.write(String(lock.held) + '\\n');`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  children.push(child);
  const [line] = (await once(child.stdout!, 'data')) as [Buffer];
  expect(String(line).trim()).toBe('true');
  return child;
}

/** A fake hook that, like the old `session hook`, answers only after its stdin ends. */
function stdinHook(dir: string): string {
  const file = join(dir, 'stdin-hook.mjs');
  writeFileSync(
    file,
    `process.stdin.resume();
     process.stdin.on('end', () => process.stdout.write('hook:' + process.argv.slice(2).join(' ') + '\\n'));`,
  );
  return file;
}

describe('fix 7: session hook from plugin-driven apps', () => {
  it('answers a plugin hook whose caller leaves stdin open (Repro D: opencode execFile shape)', async () => {
    const home = scratch();
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home };
    const dir = stateDir(env);
    const joined: JoinedSession = {
      key: 'opencode:repro',
      agent: 'opencode',
      cwd: home,
      name: 'opencode',
      server: 'https://synthetic.invalid',
      clientId: 'client',
      accessToken: 'token',
      cursor: '0',
      deliveredWakes: [],
      sessionId: 'repro-1',
      joinedAt: '',
    };
    await updateState(dir, (state) => {
      state.sessions = [joined];
    });
    queueInbox(dir, joined.key, 'synthetic waiting message');
    const bundle = entry(
      home,
      `const { runSessionCommand } = await tsImport(${JSON.stringify(resolve('src/session-join/command.ts'))}, import.meta.url);
      await runSessionCommand(process.argv.slice(2));`,
    );
    const started = Date.now();
    // The exact call shape of the old opencode plugin: stdin stays an open pipe; the host kills at 10 s.
    const result = await new Promise<{ error: (Error & { killed?: boolean }) | null; out: string }>(
      (done) => {
        execFile(
          process.execPath,
          [bundle, 'session', 'hook', 'opencode', 'poll', '--session', 'repro-1'],
          { cwd: home, env, timeout: 10_000 },
          (error, out) => done({ error, out: String(out) }),
        );
      },
    );
    expect(result.error).toBeNull();
    expect(result.out).toBe('synthetic waiting message\n');
    console.log(`PROOF fix 7: plugin hook with open stdin answered in ${Date.now() - started} ms`);
  }, 15_000);

  it('opencode plugin closes the hook stdin, so a stdin-reading hook answers', async () => {
    const dir = scratch();
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = dir;
    try {
      const file = join(dir, 'beeline.ts');
      writeFileSync(file, fill(OPENCODE_PLUGIN, process.execPath, stdinHook(dir)));
      const plugin = (await import(file)).default as {
        server: (
          input: unknown,
        ) => Promise<{ event: (input: unknown) => Promise<void>; dispose: () => Promise<void> }>;
      };
      const prompts: { body: { parts: { text: string }[] } }[] = [];
      const hooks = await plugin.server({
        client: {
          session: {
            promptAsync: async (input: (typeof prompts)[number]) => {
              prompts.push(input);
            },
          },
        },
        directory: dir,
      });
      await hooks.event({
        event: {
          type: 'session.status',
          properties: { sessionID: 's1', status: { type: 'idle' } },
        },
      });
      await hooks.dispose();
      expect(prompts.map((prompt) => prompt.body.parts[0]!.text)).toEqual([
        'hook:session hook opencode poll --session s1',
      ]);
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
    }
  }, 15_000);

  it('pi extension closes the hook stdin, so a stdin-reading hook answers', async () => {
    const dir = scratch();
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = dir;
    try {
      const file = join(dir, 'beeline.ts');
      writeFileSync(file, fill(PI_EXTENSION, process.execPath, stdinHook(dir)));
      const extension = (await import(file)).default as (pi: unknown) => void;
      const handlers: Record<string, (...args: unknown[]) => Promise<void>> = {};
      const sent: string[] = [];
      extension({
        on: (name: string, handler: (...args: unknown[]) => Promise<void>) => {
          handlers[name] = handler;
        },
        sendUserMessage: (text: string) => {
          sent.push(text);
        },
      });
      await handlers.session_start!({}, { sessionManager: { getSessionId: () => 'p1' }, cwd: dir });
      await handlers.agent_settled!();
      await handlers.session_shutdown!();
      expect(sent).toEqual(['hook:session hook pi poll --session p1']);
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
    }
  }, 15_000);

  it('Hermes plugin gives the hook no stdin, even when Hermes itself has an open one', async () => {
    const dir = scratch();
    const plugin = join(dir, 'beeline_plugin.py');
    writeFileSync(plugin, fill(HERMES_PLUGIN, process.execPath, stdinHook(dir)));
    const script = `import importlib.util, json
spec = importlib.util.spec_from_file_location("beeline_plugin", ${JSON.stringify(plugin)})
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
hooks = {}
class Ctx:
    def register_hook(self, name, callback): hooks[name] = callback
    def register_tool(self, **_): pass
module.register(Ctx())
print(json.dumps(hooks["pre_llm_call"](session_id="h1")), flush=True)
`;
    // Hermes's own stdin stays an open pipe for the whole call.
    const child = spawn('python3', ['-c', script], {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    children.push(child);
    let out = '';
    child.stdout!.on('data', (chunk) => {
      out += chunk;
    });
    const [code] = await once(child, 'exit');
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ context: 'hook:session hook hermes poll --session h1' });
  }, 15_000);
});

describe('fix 8: session tool calls through the bridge', () => {
  const deadPid = async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(child, 'exit');
    return child.pid!;
  };

  it('goes direct when bridge.pid names a dead bridge (Repro A: the outbox waited forever)', async () => {
    const home = scratch();
    const env = { HOME: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home };
    const dir = stateDir(env);
    const joined: JoinedSession = {
      key: 'codex:/work',
      agent: 'codex',
      cwd: home,
      name: 'Codex',
      server: 'https://synthetic.invalid',
      clientId: 'client',
      accessToken: 'token',
      cursor: '0',
      deliveredWakes: [],
      joinedAt: '',
    };
    await updateState(dir, (state) => {
      state.sessions = [joined];
    });
    writeFileSync(join(dir, 'bridge.pid'), String(await deadPid()));
    vi.spyOn(process, 'cwd').mockReturnValue(home);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ data: { you: 'direct' } }) }],
        },
      }),
    );
    await runSessionCommand(['session', 'tool', 'list_chats', '{}', '--as', joined.key], env);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(log.mock.calls.flat().join('\n')).toContain('"you": "direct"');
    expect(existsSync(join(home, '.beeline', 'outbox'))).toBe(false);
  });

  describe('bridge socket', () => {
    const serve = async (
      dir: string,
      onRequest: (connection: import('node:net').Socket, line: string) => void,
    ): Promise<Server> => {
      const server = createServer((connection) => {
        let text = '';
        connection.setEncoding('utf8');
        connection.on('data', (chunk: string) => {
          text += chunk;
          if (text.includes('\n')) onRequest(connection, text.trim());
        });
      });
      server.listen(bridgeSocketPath(dir));
      await once(server, 'listening');
      return server;
    };

    it('returns the bridge answer and its refusal text unchanged', async () => {
      const dir = scratch();
      const server = await serve(dir, (connection, line) => {
        const request = JSON.parse(line) as { name: string };
        connection.end(
          JSON.stringify(
            request.name === 'good'
              ? { ok: true, data: { id: 'm' } }
              : { ok: false, error: 'Beeline answered HTTP 500' },
          ) + '\n',
        );
      });
      try {
        expect(await toolViaBridge(dir, 'k', 'good', {})).toEqual({ ok: true, data: { id: 'm' } });
        expect(await toolViaBridge(dir, 'k', 'bad', {})).toEqual({
          ok: false,
          error: 'Beeline answered HTTP 500',
        });
      } finally {
        server.close();
      }
    });

    it('settles as unknown when the bridge closes after taking the call, and as unsent with no bridge', async () => {
      const dir = scratch();
      expect(await toolViaBridge(dir, 'k', 'post', {})).toBeUndefined();
      const server = await serve(dir, (connection) => connection.destroy());
      try {
        expect(await toolViaBridge(dir, 'k', 'post', {})).toEqual({
          ok: false,
          error: 'Beeline tool result is awaiting confirmation',
        });
      } finally {
        server.close();
      }
    });
  });
});

describe('fix 9: ensureBridge hands off on the old bridge lock, not its process exit', () => {
  it('starts the new bridge once the old one releases its owner lock, even while its process lingers', async () => {
    const home = scratch('bridge-lock-');
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: home,
      XDG_STATE_HOME: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
    };
    const dir = stateDir(env);
    mkdirSync(dir, { recursive: true });
    await updateState(dir, (state) => {
      state.sessions = [
        {
          key: `claude-code:${home}`,
          agent: 'claude-code',
          cwd: home,
          name: 'Claude',
          server: 'https://synthetic.invalid',
          clientId: 'client',
          accessToken: 'synthetic',
          cursor: '0',
          deliveredWakes: [],
          sessionId: 'lock-handoff',
          joinedAt: '',
          deliveryGeneration: 'bound',
          deliveryMechanism: 'local',
        },
      ];
    });
    // A bridge that, on SIGTERM, releases its owner lock and then stays alive: the old wait on its exit never ended.
    mkdirSync(join(home, 'old'));
    const old = spawn(
      process.execPath,
      [
        entry(
          join(home, 'old'),
          `const { tryLock } = await tsImport(${JSON.stringify(waitModule)}, import.meta.url);
      const { writeFileSync } = await import('node:fs');
      const lock = await tryLock(${JSON.stringify(bridgeOwnerKey(dir))});
      process.on('SIGTERM', () => { void lock.release(); });
      setInterval(() => undefined, 1 << 30);
      writeFileSync(${JSON.stringify(join(dir, 'bridge.pid'))}, String(process.pid));
      process.stdout.write('serving\\n');`,
        ),
        'session',
        'bridge',
      ],
      { env, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    children.push(old);
    await once(old.stdout!, 'data');
    mkdirSync(join(home, 'new'));
    const bundle = entry(
      join(home, 'new'),
      `const { runBridge } = await tsImport(${JSON.stringify(resolve('src/session-join/bridge.ts'))}, import.meta.url);
      globalThis.fetch = async (_url, init) => {
        if (init.method === 'POST') return Response.json({ result: { capabilities: { memberStreamV1: true } } });
        return new Response(new ReadableStream({ start(controller) {
          init.signal?.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
        } }), { headers: { 'content-type': 'application/x-ndjson' } });
      };
      await runBridge(${JSON.stringify(dir)}, { node: process.execPath, bundle: process.env.BEELINE_SESSION_BUNDLE });`,
    );
    let next: number | undefined;
    try {
      await ensureBridge(dir, { node: process.execPath, bundle }, env);
      next = Number(readFileSync(join(dir, 'bridge.pid'), 'utf8'));
      expect(next).not.toBe(old.pid);
      expect(old.exitCode).toBeNull();
      expect(old.signalCode).toBeNull();
      console.log(
        'PROOF fix 9: handoff finished on the old owner lock close while the old process was still alive',
      );
    } finally {
      if (next)
        try {
          process.kill(next, 'SIGKILL');
        } catch {
          /* already gone */
        }
    }
  }, 30_000);
});

describe('fix 13 and 15: join sign-in', () => {
  const setup = (startedAt: number) => {
    const home = scratch();
    const noop = join(home, 'noop.mjs');
    writeFileSync(noop, '');
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: home,
      XDG_STATE_HOME: home,
      BEELINE_SESSION_BUNDLE: noop,
      PATH: process.env.PATH,
    };
    const dir = stateDir(env);
    mkdirSync(join(dir, 'pending'), { recursive: true });
    const state = 'p'.repeat(43);
    const url = `https://synthetic.invalid/mcp/oauth/authorize?state=${state}`;
    const file = join(
      dir,
      'pending',
      `${createHash('sha256').update(state).digest('hex').slice(0, 24)}.json`,
    );
    writeFileSync(
      file,
      JSON.stringify({
        server: 'https://synthetic.invalid',
        clientId: 'client',
        agent: 'grok',
        cwd: process.cwd(),
        name: 'grok',
        signIn: { url, verifier: 'v'.repeat(43), state },
        startedAt,
      }),
    );
    return { env, file, url };
  };
  const join_ = async (env: NodeJS.ProcessEnv) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSessionCommand(
      ['join', '--host', 'grok', '--server', 'https://synthetic.invalid'],
      env,
    );
    return log.mock.calls.flat().join('\n');
  };

  it('prints a fresh link and ends the finisher of an expired one (an unapproved link never ended before)', async () => {
    const { env, file, url } = setup(Date.now() - 11 * 60_000);
    const finisher = await holdLock(`beeline-session-sign-in:${resolve(file)}`);
    const output = await join_(env);
    expect(output).toContain('https://synthetic.invalid/mcp/oauth/authorize?');
    expect(output).not.toContain(url);
    expect(existsSync(file)).toBe(false);
    const [, signal] =
      finisher.exitCode === null && finisher.signalCode === null
        ? await once(finisher, 'exit')
        : [finisher.exitCode, finisher.signalCode];
    expect(signal).toBe('SIGTERM');
  });

  it('reprints a live link while its finisher holds it', async () => {
    const { env, file, url } = setup(Date.now() - 60_000);
    const finisher = await holdLock(`beeline-session-sign-in:${resolve(file)}`);
    expect(await join_(env)).toContain(url);
    expect(existsSync(file)).toBe(true);
    expect(finisher.exitCode).toBeNull();
  });

  it('names the host and step on stderr before registering, leaving stdout to the link', async () => {
    const home = scratch();
    const noop = join(home, 'noop.mjs');
    writeFileSync(noop, '');
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: home,
      XDG_STATE_HOME: home,
      BEELINE_SESSION_BUNDLE: noop,
      PATH: process.env.PATH,
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ client_id: 'registered' }, { status: 201 }),
    );
    const output = await join_(env);
    expect(stderr.mock.calls.map(([line]) => String(line))).toContain(
      '[beeline] waiting for synthetic.invalid to register this session (POST /mcp/oauth/register)\n',
    );
    expect(output).toContain('client_id=registered');
    expect(output).not.toContain('[beeline]');
  });
});

it('refuses takeover of a legacy bridge without an owner channel', async () => {
  const dir = scratch();
  const oldDir = join(dir, 'old'); mkdirSync(oldDir);
  const old = spawn(process.execPath, [entry(oldDir, 'setInterval(() => {}, 1000);'), 'session', 'bridge'], { stdio: 'ignore' });
  children.push(old);
  await once(old, 'spawn');
  writeFileSync(join(dir, 'bridge.pid'), String(old.pid));
  const candidateDir = join(dir, 'new'); mkdirSync(candidateDir);
  const candidate = entry(candidateDir, "process.send('ready'); setInterval(() => {}, 1000);");
  await expect(ensureBridge(dir, { node: process.execPath, bundle: candidate })).rejects.toThrow('no followable owner channel');
  expect(old.exitCode).toBeNull(); expect(old.signalCode).toBeNull();
});

it('leaves held sign-in completion under the transport read-failure policy', async () => {
  const { finishSignIn, signInLink } = await import('./beeline-api.js');
  const calls: RequestInit[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    calls.push(init);
    throw new Error('transport read failure');
  });
  await expect(finishSignIn('https://synthetic.invalid', 'client', signInLink('https://synthetic.invalid', 'client', 'member')))
    .rejects.toThrow('completion is still pending');
  expect(calls).toHaveLength(1);
  expect(calls[0]).not.toHaveProperty('dispatcher');
});
