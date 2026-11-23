import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:net';
import type { AcpClient } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { harnessStateDirsFromEnv, prepareRoomAgentCredentials } from './agent-home.js';
import { wrapAgentCommand } from './bwrap-sandbox.js';
import { PlaceSession } from './place-session.js';
import { runtimeDirectory, type AgentRuntimeRecord } from './runtime.js';
import { materializeCornerWorktree } from './workspace-checkout.js';
import { agentCornerCheckoutPaths as cornerCheckoutFolders } from './agent-corner-checkout.js';

const git = promisify(execFile);
const roots: string[] = [];
const children: ChildProcess[] = [];
const sessions: PlaceSession[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const session of sessions.splice(0)) await session.dispose();
  for (const server of servers.splice(0))
    await new Promise<void>((done) => server.close(() => done()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each([false, true])(
  'commits from the live thread sandbox after workspace setup (warm=%s)',
  async (warm) => {
    const root = await mkdtemp('/var/tmp/beeline-thread-checkout-');
    roots.push(root);
    const source = join(root, 'source');
    await mkdir(source);
    await git('git', ['init', '-b', 'main', source]);
    await writeFile(join(source, 'proof.txt'), 'seed\n');
    await git('git', ['-C', source, 'add', '.']);
    await git('git', [
      '-C',
      source,
      '-c',
      'user.name=Proof',
      '-c',
      'user.email=proof@example.com',
      'commit',
      '-m',
      'seed',
    ]);
    const supervisorRoot = join(root, 'home', '.local', 'state');
    const agentId = 'a'.repeat(64);
    const ownState = runtimeDirectory(supervisorRoot, agentId);
    const placeRoot = join(ownState, 'rooms', 'thread');
    const privateHome = join(placeRoot, 'agent-home');
    const operatorHome = join(root, 'operator');
    const credentialState = join(operatorHome, '.claude');
    await mkdir(credentialState, { recursive: true });
    const login = {
      claudeAiOauth: { accessToken: 'original', refreshToken: 'original', expiresAt: 1000 },
    };
    await writeFile(join(credentialState, '.credentials.json'), JSON.stringify(login));
    const browserSocket = join(root, 'browser', 'control.sock');
    await mkdir(join(browserSocket, '..'), { recursive: true });
    const browser = createServer((socket) => socket.end('reachable'));
    servers.push(browser);
    await new Promise<void>((done, reject) => {
      browser.once('error', reject);
      browser.listen(browserSocket, done);
    });
    const cache = join(privateHome, 'cache');
    const protectedFiles = [
      join(ownState, 'runtime.json'),
      join(operatorHome, 'settings.json'),
      join(credentialState, 'settings.json'),
      ...['agent-home/auth.json', 'agent-home/warm-transcript.json', 'turn-context.json'].map(
        (name) => join(ownState, 'rooms', 'sibling', name),
      ),
    ];
    for (const file of protectedFiles) {
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, 'protected');
    }
    await mkdir(cache, { recursive: true });
    const hostFile = join(supervisorRoot, 'host-state');
    await writeFile(hostFile, 'host');
    const input = {
      supervisorRoot,
      cornerId: 'thread',
      featureBranch: 'feature/thread',
      targetBranch: 'main',
      token: '',
      remote: `file://${source}`,
      committer: { name: 'Proof', publicKey: agentId },
    };
    const { path, gitCommonDir } = cornerCheckoutFolders(supervisorRoot, 'thread', agentId);
    const client = Object.assign(new EventEmitter(), {
      isAlive: true,
      startProcess: async () => {},
      stopProcess: async () => {},
      sessionNew: async () => ({ sessionId: 'live', raw: { configOptions: [] } }),
      canLoadSession: () => false,
    });
    let launch: ConstructorParameters<typeof AcpClient>[0] | undefined;
    const session = new PlaceSession({
      agent: { publicKey: agentId, name: 'Proof' },
      runtime: { supervisorRoot, agent: { publicKey: agentId } } as AgentRuntimeRecord,
      config: {
        workspaceRoot: placeRoot,
        agentHomeRoot: privateHome,
        operatorHome,
        agentBinary: 'claude',
        agentKind: 'claude',
        agentEnv: {},
        bwrapPath: '/usr/bin/bwrap',
        browserShareHostSocket: browserSocket,
        readonlyMcpCommand: 'fixture',
        mcpBinary: 'fixture',
      } as BodyConfig,
      api: {
        baseUrl: 'https://synthetic.test',
        execute: async () => new Promise(() => {}),
        refreshMachineVault: async () => {},
        connection: () => ({
          baseUrl: 'http://localhost',
          daemonToken: 'fixture',
          agentId,
          helperVersion: 'test',
        }),
      } as unknown as DaemonApiClient,
      placeId: 'thread',
      parentRoomId: 'parent',
      workspaceId: 'workspace',
      onExit() {},
      createAcpClient: (options) => {
        launch = options;
        return client as unknown as AcpClient;
      },
    });
    sessions.push(session);
    await session.start();
    if (warm) await materializeCornerWorktree(input);
    const inode = (await stat(gitCommonDir)).ino;
    const probe = `
      console.log('ready');
      require('node:readline').createInterface({ input: process.stdin }).once('line', async () => {
        try {
          require('node:fs').writeFileSync('proof.txt', 'thread edit\\n');
          require('node:fs').writeFileSync(${JSON.stringify(join(placeRoot, 'own-state'))}, 'private');
          const loginDir = process.env.CLAUDE_CONFIG_DIR;
          // The proxy owns the login: the session holds no Claude login file.
          if (require('node:fs').existsSync(loginDir + '/.credentials.json')) throw new Error('session holds a login');
          require('node:fs').writeFileSync(loginDir + '/refresh-lock', 'refresh');
          const reached = await new Promise((done, reject) => {
            let data = '';
            const socket = require('node:net').createConnection(${JSON.stringify(browserSocket)});
            socket.on('data', chunk => { data += chunk; });
            socket.on('end', () => done(data));
            socket.on('error', reject);
          });
          if (reached !== 'reachable') throw new Error('browser socket unreachable');
          try { require('node:fs').unlinkSync(${JSON.stringify(browserSocket)}); throw new Error('browser unlink unexpectedly succeeded'); }
          catch (error) { if (error.code !== 'EROFS') throw error; }
          require('node:fs').writeFileSync(${JSON.stringify(join(cache, 'private'))}, 'cache');
          for (const file of ${JSON.stringify([hostFile, ...protectedFiles])}) {
            if (require('node:fs').readFileSync(file, 'utf8') !== (file === ${JSON.stringify(hostFile)} ? 'host' : 'protected')) throw new Error('protected state unreadable');
            try { require('node:fs').writeFileSync(file, 'escape'); throw new Error('protected write unexpectedly succeeded'); }
            catch (error) { if (error.code !== 'EROFS') throw error; }
          }
          const git = args => require('node:child_process').execFileSync('/usr/bin/git', args, { encoding: 'utf8' });
          git(['add', 'proof.txt']);
          git(['commit', '-m', 'thread edit']);
          console.log(git(['rev-parse', 'HEAD']).trim());
        } catch (error) { console.error(error.stderr?.toString() ?? String(error)); process.exitCode = 1; }
        process.stdin.destroy();
      });
    `;
    expect(launch?.agentCommand).toBe('/usr/bin/bwrap');
    const commandIndex = launch!.agentArgs!.lastIndexOf(launch!.harnessCommand!);
    expect(commandIndex).toBeGreaterThan(0);
    const child = spawn(
      launch!.agentCommand,
      [...launch!.agentArgs!.slice(0, commandIndex), process.execPath, '-e', probe],
      { env: { ...process.env, ...launch!.agentEnv }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    children.push(child);
    const lines: string[] = [];
    let stderr = '';
    child.stderr!.on('data', (chunk) => {
      stderr += chunk;
    });
    const ended = new Promise<number | null>((resolve) => child.once('exit', resolve));
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        reject(new Error(`sandbox exited before ready: ${code}: ${stderr}`)),
      );
      createInterface({ input: child.stdout! }).on('line', (line) => {
        lines.push(line);
        if (line === 'ready') resolve();
      });
    });
    await materializeCornerWorktree(input);
    child.stdin!.end('commit\n');
    expect(await ended, stderr).toBe(0);
    expect((await stat(gitCommonDir)).ino).toBe(inode);
    const head = (await git('git', ['-C', path, 'rev-parse', 'HEAD'])).stdout.trim();
    expect(lines.at(-1)).toBe(head);
    expect(await readFile(join(path, 'proof.txt'), 'utf8')).toBe('thread edit\n');
    expect(await readFile(join(cache, 'private'), 'utf8')).toBe('cache');
    expect(await readFile(join(placeRoot, 'own-state'), 'utf8')).toBe('private');
    expect(await readFile(join(privateHome, 'claude', 'refresh-lock'), 'utf8')).toBe('refresh');
    expect(JSON.parse(await readFile(join(credentialState, '.credentials.json'), 'utf8'))).toEqual(
      login,
    );
    expect(await readFile(hostFile, 'utf8')).toBe('host');
    for (const file of protectedFiles) expect(await readFile(file, 'utf8')).toBe('protected');
  },
);

it('keeps operator Claude settings and login read-only in a proxied Room', async () => {
  const root = await mkdtemp('/var/tmp/beeline-room-login-');
  roots.push(root);
  const operatorHome = join(root, 'operator');
  const settings = join(operatorHome, '.claude', 'settings.json');
  const source = join(root, 'source.txt');
  const login = JSON.stringify({ claudeAiOauth: { accessToken: 'signed-in', expiresAt: 1000 } });
  await mkdir(join(operatorHome, '.claude'), { recursive: true });
  await writeFile(join(operatorHome, '.claude', '.credentials.json'), login);
  await writeFile(settings, 'protected');
  await writeFile(source, 'source');
  const overlay = await prepareRoomAgentCredentials({
    root: join(root, 'thread', 'agent-home'),
    operatorHome,
    agentKind: 'claude',
  });
  try {
    const { stateDirs, tmpDir } = harnessStateDirsFromEnv(overlay);
    const command = wrapAgentCommand({
      bwrapPath: '/usr/bin/bwrap',
      spec: { mode: 'readonly', cwd: root, harnessStateDirs: stateDirs, tmpDir },
      command: process.execPath,
      args: [
        '-e',
        `
        const fs = require('node:fs');
        const assert = require('node:assert/strict');
        const loginDir = process.env.CLAUDE_CONFIG_DIR;
        assert.equal(fs.existsSync(loginDir + '/.credentials.json'), false);
        fs.writeFileSync(loginDir + '/refresh-lock', 'private');
        for (const path of ${JSON.stringify([settings, source, join(operatorHome, '.claude', '.credentials.json')])}) {
          assert.throws(() => fs.writeFileSync(path, 'escape'), { code: 'EROFS' });
        }
      `,
      ],
    });
    await git(command.command, command.args, { env: { ...process.env, ...overlay } });
    expect(await readFile(settings, 'utf8')).toBe('protected');
    expect(await readFile(source, 'utf8')).toBe('source');
    expect(await readFile(join(overlay.CLAUDE_CONFIG_DIR!, 'refresh-lock'), 'utf8')).toBe(
      'private',
    );
  } finally {
    await rm(overlay.TMPDIR!, { force: true });
  }
});
