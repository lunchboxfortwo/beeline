import { mkdir,readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { grantedSquireHostRoute } from './host-mcp-route.js';
import type { McpServerWire } from './acp.js';
import { writeIsolatedHarnessFile } from './agent-home.js';

/** Pi ACP loads this private bridge without contacting optional servers.
 * Their discovery and execution belong to explicit agent tool calls. */
export const PI_MCP_BRIDGE_FILENAME = 'beeline-mcp-bridge.js';

type PiMcpConfig = { mcpServers?: Record<string, Record<string, unknown>>; [key: string]: unknown };
type PiMountedServer = McpServerWire & { cwd?: string };

async function isolatedPiConfig(piHome: string): Promise<PiMcpConfig> {
  try {
    const parsed = JSON.parse(await readFile(resolve(piHome, 'mcp.json'), 'utf8')) as PiMcpConfig;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn('[body] isolated Pi MCP config could not be read:', error);
    return {};
  }
}

function importedStdioServers(
  config: PiMcpConfig,
  sessionServers: readonly McpServerWire[],
): PiMountedServer[] {
  const owned = new Set(sessionServers.map((server) => server.name));
  return Object.entries(config.mcpServers ?? {}).flatMap(([name, value]) => {
    if (owned.has(name) || !value || value.enabled === false) return [];
    if (
      typeof value.command !== 'string' ||
      (value.args !== undefined &&
        (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === 'string'))) ||
      (value.env !== undefined &&
        (typeof value.env !== 'object' ||
          !value.env ||
          Array.isArray(value.env) ||
          Object.values(value.env).some((entry) => typeof entry !== 'string'))) ||
      (value.cwd !== undefined && typeof value.cwd !== 'string')
    ) {
      console.warn(
        `[body] Pi bridge cannot mount imported MCP server ${name}; use Pi native MCP for this transport`,
      );
      return [];
    }
    return [
      {
        name,
        command: value.command,
        args: value.args as string[] | undefined,
        ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
        env: Object.entries(value.env ?? {}).map(([key, entry]) => ({
          name: key,
          value: entry as string,
        })),
      },
    ];
  });
}

function isPiAcpCommand(agentCommand: string | undefined): boolean {
  return Boolean(agentCommand && /(^|[/\\])pi-acp(\.[a-z]+)?$/i.test(agentCommand));
}

/**
 * The extension source for one session's servers.
 *
 * Pure and exported so tests can run the bridge against real stdio processes.
 */
export function piMcpBridgeSource(servers: readonly PiMountedServer[]): string {
  const manifest = servers.map((server) => ({
    name: server.name,
    // Rewritten aliases carry the broker socket even after their original launch is replaced.
    requiresSquireAuthorization:
      !server.env?.some((entry) => entry.name === 'BEELINE_RESOURCE_AUTH_FILE') &&
      (grantedSquireHostRoute([server.name], {
        [server.name]: { command: server.command, args: server.args },
      }) ||
        Boolean(
          server.env?.some((entry) => entry.name === 'TRUSTY_SQUIRE_BROKER_SOCKET' && entry.value),
        )),
    command: server.command,
    args: server.args ?? [],
    ...(server.cwd ? { cwd: server.cwd } : {}),
    env: Object.fromEntries((server.env ?? []).map((entry) => [entry.name, entry.value])),
  }));
  return `${BRIDGE_PREAMBLE}const SERVERS = ${JSON.stringify(manifest, null, 2)};\n${BRIDGE_BODY}`;
}

/**
 * Write the bridge into a pi session's isolated home, if this harness needs it.
 *
 * Returns the config or extension path written, or undefined for another
 * harness. A write failure is logged and does not stop ordinary read tools.
 */
export async function installPiMcpBridge(input: {
  agentCommand?: string;
  /** `PI_CODING_AGENT_DIR` for this session, from the prepared home overlay. */
  piHome?: string;
  servers: readonly McpServerWire[];
}): Promise<string | undefined> {
  if (!isPiAcpCommand(input.agentCommand)) return undefined;
  if (!input.piHome) return undefined;
  const directory = resolve(input.piHome, 'extensions');
  const path = resolve(directory, PI_MCP_BRIDGE_FILENAME);
  try {
    const config = await isolatedPiConfig(input.piHome);
    const servers = [...input.servers, ...importedStdioServers(config, input.servers)];
    if (!servers.length) return undefined;
    // Keep native Pi auto-discovery disabled for these bridge-owned routes.
    const mcpServers = { ...config.mcpServers };
    for (const server of servers)
      mcpServers[server.name] = {
        command: server.command,
        args: server.args ?? [],
        env: Object.fromEntries((server.env ?? []).map((entry) => [entry.name, entry.value])),
        enabled: false,
      };
    await writeIsolatedHarnessFile(
      resolve(input.piHome, 'mcp.json'),
      `${JSON.stringify({ ...config, mcpServers }, null, 2)}\n`,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeIsolatedHarnessFile(path, piMcpBridgeSource(servers));
    return path;
  } catch (error) {
    console.error('[body] pi MCP bridge could not be written', path, error);
    return undefined;
  }
}

const BRIDGE_PREAMBLE = `// Generated by Beeline for one Room session. Do not edit: it is rewritten on
// every activation. Discovery happens only inside an explicit tool call.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

`;

const BRIDGE_BODY = `/**
 * One request/response against a short-lived stdio route. Squire's route is
 * only a proxy: its real MCP connection is held by SquireTaskRelay in the
 * helper across these processes and across Pi ACP replacements.
 */
function callServer(server, request, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(server.command, server.args, {
      env: { ...process.env, ...server.env },
      ...(server.cwd ? { cwd: server.cwd } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let buffer = '';
    let stderr = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      child.kill('SIGKILL');
      if (error) rejectPromise(error); else resolvePromise(value);
    };
    const onAbort = () => finish(new Error(server.name + ' call cancelled'));
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener?.('abort', onAbort, { once: true });
    }
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2048); });
    child.on('error', (error) => finish(new Error(server.name + ' failed to start: ' + error.message)));
    child.on('close', (code, signal) => finish(new Error(
      server.name + ' exited before answering (code ' + code + ', signal ' + signal + ')' +
      (stderr.trim() ? ': ' + stderr.trim() : ': no stderr'),
    )));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          let message;
          try { message = JSON.parse(line); } catch { message = undefined; }
          // Only the answer to OUR id: the initialize reply and any
          // notification the server writes share this stream.
          if (message && message.id === request.id) {
            if (message.error) {
              finish(new Error(message.error.message || 'MCP error'));
            } else {
              finish(undefined, message.result ?? {});
            }
            return;
          }
        }
        newline = buffer.indexOf('\\n');
      }
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'beeline-pi-bridge', version: '1.0.0' },
        },
      }) + '\\n',
    );
    child.stdin.write(JSON.stringify(request) + '\\n');
  });
}

// Read the turn file for each call: a live Pi session serves multiple requesters.
// This generated harness child has no machine registration; keep its closed
// Squire permission check at the server's command-authorized HTTP ingress.
async function authorizeSquire(signal) {
  const env = SERVERS.find((server) => server.name === 'beeline-agent')?.env;
  if (!env?.BEELINE_DAEMON_BASE_URL || !env.BEELINE_DAEMON_TOKEN || !env.BEELINE_TURN_CONTEXT_FILE)
    throw new Error('Squire authorization is unavailable.');
  const context = JSON.parse(await readFile(env.BEELINE_TURN_CONTEXT_FILE, 'utf8'));
  if (![context.roomId, context.requestId].every((value) => typeof value === 'string' && value.length > 0))
    throw new Error('Squire requires an active server command.');
  const response = await fetch(new URL('/v1/daemon/operations/authorizeSquireCall', env.BEELINE_DAEMON_BASE_URL), {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.BEELINE_DAEMON_TOKEN, 'content-type': 'application/json',
      'x-beeline-helper-version': env.BEELINE_HELPER_VERSION || 'v0.0.0' },
    body: JSON.stringify({ roomId: context.roomId, requestId: context.requestId }),
    signal,
  });
  if (!response.ok) throw new Error('Squire authorization is unavailable.');
  const result = await response.json();
  if (result?.allowed !== true) throw new Error('Squire requires approval from its owner for this requester.');
}

function textOf(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\\n');
  return text || 'The tool returned no text.';
}

function labelOf(name) {
  return name.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase());
}

export default function (pi) {
  for (const server of SERVERS) pi.registerTool({
    name: server.name + '__mcp',
    label: labelOf(server.name),
    description: 'Use with no name to list this MCP server tools, then supply a listed name and arguments to call one. Discovery runs only when you request it.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } } },
    async execute(toolCallId, params, signal) {
      if (params?.name && server.requiresSquireAuthorization) await authorizeSquire(signal);
      const result = await callServer(server, params?.name ? {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: params.name, arguments: params.arguments ?? {}, _meta: { beelineToolCallId: toolCallId } },
      } : { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, signal);
      if (result?.isError) throw new Error(textOf(result));
      return { content: [{ type: 'text', text: Array.isArray(result?.tools) ? JSON.stringify(result) : textOf(result) }], details: {} };
    },
  });
}
`;
