/**
 * The machine's one CLIProxyAPI child: the sole owner of every proxied
 * provider login (Claude, ChatGPT/Codex, xAI), and the routes that point
 * each session's harness at it.
 *
 * Sessions never hold a provider refresh token. A harness reaches the proxy
 * through its own provider configuration with only the local inference key;
 * the proxy alone exchanges and persists refresh tokens, so two sessions on
 * one account cannot spend each other's rotation. Routes are same-provider.
 * Pi, OpenCode and Goose route a subscription provider here only when the
 * session holds no key of its own for it.
 *
 * Config, logins and the binary live under `~/.config/beeline/cliproxy`,
 * inside the `.config/beeline` mask every sandbox applies (`bwrap-sandbox.ts`).
 * The management key never leaves this process. `/login` runs the proxy's own
 * device login or hands it Beeline's Claude login once; plan reads use its
 * current login (`readLogin`).
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { parse } from 'yaml';
import { agentBehavior, type AgentKind } from './agent-command.js';
import { readJsonObject, writePrivateFileAtomically } from './atomic-private-file.js';
import { downloadBytes } from './update-download.js';
import { ask, runOwned } from './wait.js';

const execFileAsync = promisify(execFile);
const RELEASES = 'https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest';
const BINARY = 'cli-proxy-api';

/** Providers whose login the proxy owns, named as the proxy names them. */
export type ProxiedProvider = 'claude' | 'codex' | 'xai';

export type CliProxyEndpoint = { readonly url: string; readonly key: string };

export function cliProxyDir(operatorHome: string = homedir()): string {
  return resolve(operatorHome, '.config', 'beeline', 'cliproxy');
}

/** Install the latest release, only when its published checksum matches, and make it current. */
export async function installLatestCliProxy(
  operatorHome?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const bin = join(cliProxyDir(operatorHome), 'bin');
  const release = JSON.parse(
    Buffer.from(await downloadBytes(RELEASES, fetchImpl)).toString('utf8'),
  ) as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] };
  const version = release.tag_name?.replace(/^v/, '');
  if (!version) throw new Error('CLIProxyAPI latest release has no version');
  const target = join(bin, version, BINARY);
  if (!existsSync(target)) {
    const name = `CLIProxyAPI_${version}_${process.platform === 'darwin' ? 'darwin' : 'linux'}_${process.arch === 'arm64' ? 'aarch64' : 'amd64'}.tar.gz`;
    const download = (file: string) => {
      const url = release.assets?.find((asset) => asset.name === file)?.browser_download_url;
      if (!url) throw new Error(`CLIProxyAPI ${version} has no ${file}`);
      return downloadBytes(url, fetchImpl);
    };
    const archive = Buffer.from(await download(name));
    const digest = createHash('sha256').update(archive).digest('hex');
    if (
      !Buffer.from(await download('checksums.txt'))
        .toString('utf8')
        .split('\n')
        .some((line) => line.trim() === `${digest}  ${name}`)
    )
      throw new Error(`CLIProxyAPI ${name} does not match its release checksum`);
    await mkdir(join(bin, version), { recursive: true, mode: 0o700 });
    await writeFile(join(bin, version, name), archive, { mode: 0o600 });
    try {
      const tar = await runOwned({
        step: 'CLIProxyAPI unpack',
        file: 'tar',
        args: ['-xzf', join(bin, version, name), '-C', join(bin, version), BINARY],
      });
      if (tar.code !== 0)
        throw new Error(
          `CLIProxyAPI unpack failed (${tar.signal ?? `exit ${tar.code}`}): ${tar.stderr.trim()}`,
        );
    } finally {
      await rm(join(bin, version, name), { force: true });
    }
  }
  await writePrivateFileAtomically(join(bin, 'current'), `${version}\n`);
  return target;
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer().once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}

export class CliProxy {
  /** Set by the first start; a restarted child keeps sessions' URL and key. */
  endpoint?: CliProxyEndpoint;
  readonly #managementKey = randomBytes(24).toString('base64url');
  #binary?: string;
  #child?: ChildProcess;
  #starting?: Promise<void>;

  constructor(private readonly operatorHome: string = homedir()) {}

  /** Start the child unless it is running; resolves once it serves. */
  start(): Promise<void> {
    if (this.#child && !this.#starting) return Promise.resolve();
    this.#starting ??= this.#start().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async #start(): Promise<void> {
    const dir = cliProxyDir(this.operatorHome);
    this.endpoint ??= {
      url: `http://127.0.0.1:${await freePort()}`,
      key: randomBytes(24).toString('base64url'),
    };
    const version = (await readFile(join(dir, 'bin', 'current'), 'utf8').catch(() => '')).trim();
    this.#binary ??=
      version && existsSync(join(dir, 'bin', version, BINARY))
        ? join(dir, 'bin', version, BINARY)
        : await installLatestCliProxy(this.operatorHome);
    const config = join(dir, 'config.yaml');
    await mkdir(join(dir, 'auth'), { recursive: true, mode: 0o700 });
    await writePrivateFileAtomically(
      config,
      [
        'config-version: 8',
        `server: { host: "127.0.0.1", port: ${new URL(this.endpoint.url).port} }`,
        `management: { allow-remote: false, secret-key: ${JSON.stringify(this.#managementKey)}, disable-control-panel: true }`,
        `access: { api-keys: [${JSON.stringify(this.endpoint.key)}] }`,
        `oauth: { auth-dir: ${JSON.stringify(join(dir, 'auth'))} }`,
        '',
      ].join('\n'),
    );
    // A child left by a helper that died without its service manager would
    // refresh the same logins beside this one.
    await execFileAsync('pkill', ['-f', `${BINARY} -config ${config}`]).catch(() => undefined);
    const child = spawn(this.#binary, ['-config', config], {
      cwd: dir,
      env: { HOME: dir, PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.#child = child;
    child.once('exit', () => {
      if (this.#child === child) this.#child = undefined;
    });
    await new Promise<void>((ready, fail) => {
      let output = '';
      const read = (chunk: Buffer) => {
        output = `${output}${chunk.toString('utf8')}`.slice(-4_000);
        if (output.includes('API server started successfully')) ready();
      };
      child.stdout?.on('data', read);
      child.stderr?.on('data', read);
      child.once('error', fail);
      child.once('exit', (code) =>
        fail(new Error(`CLIProxyAPI exited ${code}: ${output.trim().split('\n').at(-1) ?? ''}`)),
      );
    });
  }

  /** Stop the child; resolves once it has exited. */
  stop(): Promise<void> {
    const child = this.#child;
    if (!child) return Promise.resolve();
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    child.kill('SIGTERM');
    return exited;
  }

  /** The proxy's own headless device login (`-codex-device-login`, `-xai-login`); it saves the login itself. */
  login(flag: string): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
    const dir = cliProxyDir(this.operatorHome);
    return {
      command: this.#binary!,
      args: [flag, '-no-browser', '-config', join(dir, 'config.yaml')],
      env: { HOME: dir, PATH: process.env.PATH ?? '' },
    };
  }

  async #management(path: string, init: RequestInit = {}): Promise<unknown> {
    await this.start();
    const response = await ask(
      { url: `${this.endpoint!.url}/v0/management/${path}`, peer: 'CLIProxyAPI management' },
      {
        ...init,
        headers: {
          authorization: `Bearer ${this.#managementKey}`,
          'content-type': 'application/json',
        },
      },
    );
    if (!response.ok)
      throw new Error(`CLIProxyAPI ${path.split('?')[0]} answered ${response.status}`);
    return response.json();
  }

  /** Hand a finished login to the proxy; it replaces this provider's previous one. */
  async saveLogin(provider: ProxiedProvider, login: Record<string, unknown>): Promise<void> {
    await this.#management(`auth-files?name=beeline-${provider}.json`, {
      method: 'POST',
      body: JSON.stringify({ ...login, type: provider }),
    });
  }

  /** The provider's login as the proxy holds it now, or undefined when none is saved. */
  async readLogin(provider: ProxiedProvider): Promise<Record<string, unknown> | undefined> {
    const { files } = (await this.#management('auth-files')) as {
      files?: { name: string; provider?: string; disabled?: boolean }[];
    };
    const file = files?.find((entry) => entry.provider === provider && !entry.disabled);
    return file
      ? ((await this.#management(
          `auth-files/download?name=${encodeURIComponent(file.name)}`,
        )) as Record<string, unknown>)
      : undefined;
  }
}

let machineProxy: CliProxy | undefined;

/** The machine helper owns the one proxy; it starts it with its own home. */
export function startMachineCliProxy(
  operatorHome: string = homedir(),
): Promise<CliProxy | undefined> {
  machineProxy ??= new CliProxy(operatorHome);
  return machineCliProxy();
}

/** The machine helper's proxy, restarted if it stopped; undefined while it cannot run. */
export async function machineCliProxy(): Promise<CliProxy | undefined> {
  try {
    await machineProxy?.start();
    return machineProxy;
  } catch (error) {
    console.error('[cliproxy] not running:', error instanceof Error ? error.message : error);
    return undefined;
  }
}

/** The machine proxy's stable endpoint, without waiting for it to serve. */
export function machineCliProxyEndpoint(): CliProxyEndpoint | undefined {
  return machineProxy?.endpoint;
}

export function stopMachineCliProxy(): void {
  void machineProxy?.stop();
}

/** Provider ids as Pi, OpenCode and Goose name them, with the key that keeps them native. */
const ROUTES = [
  { provider: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY', root: '', login: 'claude' },
  { provider: 'openai', keyEnv: 'OPENAI_API_KEY', root: '/v1', login: 'codex' },
  { provider: 'xai', keyEnv: 'XAI_API_KEY', root: '/v1', login: 'xai' },
  // Pi's ChatGPT subscription: no API key of its own; served as Responses models.
  { provider: 'openai-codex', keyEnv: '', root: '/v1', login: 'codex' },
] as const;

const readStore = async (path: string) =>
  (parse(await readFile(path, 'utf8').catch(() => '')) ?? {}) as Record<
    string,
    { key?: unknown; apiKey?: unknown } | undefined
  >;

/** This harness's subscription routes for every provider it holds no key for; Pi custom providers count when keyed. */
async function unkeyedRoutes(
  kind: AgentKind | undefined,
  env: Record<string, string>,
  home: string,
) {
  const { providers = [], keyStore = '' } = agentBehavior(kind).cliProxy ?? {};
  const stored = await readStore(resolve(home, keyStore));
  const held = ((await readJsonObject(resolve(home, '.pi/agent/models.json'))).providers ??
    {}) as Record<string, { apiKey?: unknown }>;
  return ROUTES.filter(
    (route) =>
      providers.includes(route.provider) &&
      !env[route.keyEnv] &&
      !stored[route.keyEnv] &&
      !stored[route.provider]?.key &&
      !(agentBehavior(kind).hostedModelConfig === 'model-file' && held[route.provider]?.apiKey),
  );
}

/** The proxy login `/login` signs in to for this harness's current provider, if proxied. */
export async function cliProxyLogin(
  kind: AgentKind,
  model: string | undefined,
  env: Record<string, string>,
  home: string,
): Promise<ProxiedProvider | undefined> {
  const { cliProxy, providerModelEnv } = agentBehavior(kind);
  if (cliProxy?.login) return cliProxy.login;
  const config = cliProxy?.providerConfig
    ? await readStore(resolve(home, cliProxy.providerConfig))
    : {};
  const provider = providerModelEnv
    ? (env[providerModelEnv.provider] ?? config[providerModelEnv.provider])
    : model?.split('/')[0];
  return (await unkeyedRoutes(kind, env, home)).find((route) => route.provider === provider)?.login;
}

/** Pi `models.json` provider overrides: built-in models stay, endpoint and key change. */
export async function piCliProxyProviders(
  proxy: CliProxyEndpoint | undefined,
  env: Record<string, string>,
  home: string,
  operatorModels: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!proxy) return {};
  return Object.fromEntries(
    (await unkeyedRoutes('pi', env, home)).map((route) => [
      route.provider,
      {
        ...(operatorModels[route.provider] as object),
        baseUrl: `${proxy.url}${route.root}`,
        apiKey: proxy.key,
        ...(!route.keyEnv
          ? {
              models: [
                ...openaiCodexProvider().getModels(),
                ...((operatorModels[route.provider] as { models?: object[] })?.models ?? []),
              ].map((model) => ({ ...model, api: 'openai-responses', baseUrl: `${proxy.url}/v1` })),
            }
          : {}),
      },
    ]),
  );
}

/** The env overlay that points this harness at the proxy; empty while it is down. */
export async function cliProxyHarnessEnv(input: {
  kind: AgentKind | undefined;
  root: string;
  operatorHome?: string;
  proxy: CliProxyEndpoint | undefined;
  env: Record<string, string>;
}): Promise<Record<string, string>> {
  const { proxy, root, env } = input;
  const route = agentBehavior(input.kind).cliProxy?.route;
  if (!proxy || !route) return {};
  switch (route) {
    case 'claude-env':
      return {
        ANTHROPIC_BASE_URL: proxy.url,
        ANTHROPIC_AUTH_TOKEN: proxy.key,
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
      };
    case 'codex-env':
      // codex-acp's own gateway sign-in: routing to the proxy, no OpenAI login.
      return {
        DEFAULT_AUTH_REQUEST: JSON.stringify({
          methodId: 'gateway',
          _meta: {
            gateway: {
              baseUrl: `${proxy.url}/v1`,
              headers: { Authorization: `Bearer ${proxy.key}` },
              providerName: 'Beeline',
            },
          },
        }),
      };
    case 'grok-env':
      // Grok's ACP server starts a session only for a stored sign-in: an
      // external-provider record whose token, re-minted by its command, is the local key.
      await writePrivateFileAtomically(
        resolve(root, 'grok', 'auth.json'),
        JSON.stringify({
          'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
            key: proxy.key,
            auth_mode: 'external',
            create_time: new Date().toISOString(),
            user_id: '',
            email: null,
            coding_data_retention_opt_out: true,
          },
        }),
      );
      return {
        GROK_HOME: resolve(root, 'grok'),
        GROK_MODELS_BASE_URL: `${proxy.url}/v1`,
        XAI_API_KEY: proxy.key,
        GROK_AUTH_PROVIDER_COMMAND: `echo ${proxy.key}`,
      };
    case 'opencode-env': {
      const routes = await unkeyedRoutes(input.kind, env, input.operatorHome ?? homedir());
      return routes.length
        ? {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              provider: Object.fromEntries(
                routes.map((entry) => [
                  entry.provider,
                  { options: { baseURL: `${proxy.url}/v1`, apiKey: proxy.key } },
                ]),
              ),
            }),
          }
        : {};
    }
    case 'goose-env':
      return Object.fromEntries(
        (await unkeyedRoutes(input.kind, env, input.operatorHome ?? homedir())).flatMap((entry) => [
          [`${entry.provider.toUpperCase()}_HOST`, proxy.url],
          [entry.keyEnv, proxy.key],
        ]),
      );
    case 'pi-models':
      return {};
  }
}
