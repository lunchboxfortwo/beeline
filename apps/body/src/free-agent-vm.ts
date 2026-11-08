import { parseOpenRouterEndpoints, piInputModalities } from './openrouter-routing.js';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writePrivateFileAtomically } from './atomic-private-file.js';
import { LEGACY_ACCESS_POLICY } from './access-policy.js';
import { agentBehavior, resolveAgentCommand } from './agent-command.js';
import { loadBodyConfig, parseEnvFile } from './config.js';
import { activateDaemonTransport } from './daemon-api-client.js';
import { runMachineHelper } from './machine-helper.js';
import {
  defaultSupervisorRoot,
  identityFromKey,
  readRuntimeRecord,
  runtimeConfigPath,
  runtimeDirectory,
  stageMonolithAgentRuntime,
  writeRuntimeRecord,
} from './runtime.js';

/**
 * `beeline free-agent`: the entry point on a free starter agent's Fly Machine.
 * The first boot trades the Machine's one-time bootstrap token for its agent
 * identity, a daemon exchange token and a model token; every boot then hosts
 * that one agent. The server owns Machine suspension. The Machine's
 * root filesystem persists, so later boots skip the bootstrap.
 */
export interface FreeAgentGrant {
  agentId: string;
  agentSecretKey: string;
  bodySecretKey: string;
  agentName: string;
  harness: 'pi' | 'opencode';
  model: string;
  soul: string;
  workspaceId: string;
  workspaceName: string;
  pairedBy: string;
  monolithBaseUrl: string;
  daemonExchangeToken: string;
  modelToken: string;
  modelBaseUrl: string;
  upstreamModel: string;
}

/** Pi's private provider uses only the scoped proxy token, resolved from env. */
export function freeAgentPiConfig(grant: Pick<FreeAgentGrant, 'modelBaseUrl' | 'upstreamModel'>, input: Array<'text' | 'image'> = ['text']): string {
  return JSON.stringify({
    providers: {
      beeline: {
        baseUrl: grant.modelBaseUrl,
        api: 'openai-completions',
        apiKey: '$BEELINE_FREE_AGENT_MODEL_TOKEN',
        models: [{
          id: grant.upstreamModel,
          name: grant.upstreamModel,
          reasoning: true,
          input,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000_000,
          maxTokens: 65_536,
        }],
      },
    },
  });
}

async function freeAgentInput(model: string): Promise<Array<'text' | 'image'>> {
  try {
    const response = await fetch(`https://openrouter.ai/api/v1/models/${model}/endpoints`, {
      signal: undefined,
    });
    if (!response.ok) return ['text'];
    return piInputModalities(parseOpenRouterEndpoints(await response.json()).inputModalities) ?? ['text'];
  } catch {
    return ['text'];
  }
}

/** Values are single lines; parseEnvFile does not unescape quoted values. */
export function freeAgentModelEnv(grant: Pick<FreeAgentGrant, 'modelToken'>): string {
  const lines = {
    BEELINE_FREE_AGENT_MODEL_TOKEN: grant.modelToken,
    AGENT_BROWSER_ENGINE: 'lightpanda',
    AGENT_BROWSER_EXECUTABLE_PATH: '/usr/local/bin/lightpanda',
    // Each Room sandbox has its own /tmp; long harness homes exceed AF_UNIX limits.
    AGENT_BROWSER_SOCKET_DIR: '/tmp/beeline-browser',
    BEELINE_BODY_AGENT_ENV_PASSTHROUGH: [
      'BEELINE_FREE_AGENT_MODEL_TOKEN', 'AGENT_BROWSER_ENGINE', 'AGENT_BROWSER_EXECUTABLE_PATH', 'AGENT_BROWSER_SOCKET_DIR',
    ].join(','),
  };
  return `${Object.entries(lines)
    .map(([key, value]) => `${key}=${value.replace(/[\r\n]/g, '')}`)
    .join('\n')}\n`;
}

export async function fetchFreeAgentGrant(
  serverUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  _legacySleep?: (ms: number) => Promise<void>,
): Promise<FreeAgentGrant> {
  const response=await fetchImpl(new URL('/v1/free-agents/bootstrap',serverUrl),{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token}),signal:undefined,
  });
  if(response.status===401)throw new Error('free agent bootstrap token was refused');
  if(!response.ok)throw new Error(`free agent bootstrap failed: HTTP ${response.status}`);
  return await response.json() as FreeAgentGrant;
}

async function hasDaemonToken(configPath: string): Promise<boolean> {
  try {
    const transport = (await readRuntimeRecord(configPath)).transport;
    return Boolean(transport && 'daemonToken' in transport && transport.daemonToken);
  } catch {
    return false;
  }
}

/** Stage and activate this Machine's one agent from its bootstrap grant. */
export async function stageFreeAgent(
  env: NodeJS.ProcessEnv,
  grant: FreeAgentGrant,
): Promise<{ configPath: string }> {
  const supervisorRoot = defaultSupervisorRoot(env);
  const directory = resolve(supervisorRoot, 'beeline', 'free-agent');
  const llmEnvFile = resolve(directory, 'model.env');
  await writePrivateFileAtomically(llmEnvFile, freeAgentModelEnv(grant));
  await writePrivateFileAtomically(resolve(env.HOME ?? '/root', '.pi/agent/models.json'), freeAgentPiConfig(grant, await freeAgentInput(grant.upstreamModel)));
  const agent = await freeAgentPiCommand(env);
  const localConfig = loadBodyConfig({ workspaceRoot: process.cwd(), llmEnvFile, agent, env });
  const staged = await stageMonolithAgentRuntime({
    workspaceId: grant.workspaceId,
    pairedBy: grant.pairedBy,
    monolithBaseUrl: grant.monolithBaseUrl,
    daemonExchangeToken: grant.daemonExchangeToken,
    llmEnvFile,
    agentBinary: localConfig.agentBinary,
    agentKind: agent.kind,
    agentCommand: agent.command,
    agentArgs: agent.args,
    modelSelection: { model: grant.model },
    accessPolicy: LEGACY_ACCESS_POLICY,
    mcpBinary: localConfig.mcpBinary,
    agentIdentity: identityFromKey(grant.agentSecretKey, grant.agentName),
    bodyIdentity: identityFromKey(grant.bodySecretKey, 'beeline-body'),
    supervisorRoot,
  });
  if (!(await activateDaemonTransport(staged.configPath)))
    throw new Error('free agent daemon transport activation failed');
  return { configPath: staged.configPath };
}

// Agent programs come from the Machine image or its operator, never helper downloads.
async function freeAgentPiCommand(env: NodeJS.ProcessEnv) {
  return resolveAgentCommand({ kind: 'pi', env });
}

/** Reconcile persisted environment before starting sessions, including existing Pi runtimes. */
async function upgradeFreeAgentHarness(configPath: string, env: NodeJS.ProcessEnv): Promise<void> {
  const runtime = await readRuntimeRecord(configPath);
  if (!agentBehavior(runtime.agentKind).hostedModelConfig || !runtime.llmEnvFile)
    throw new Error('unsupported persisted free agent harness');
  const original = await readFile(runtime.llmEnvFile, 'utf8');
  const previous = parseEnvFile(runtime.llmEnvFile);
  const canonicalName = (name: string) => name.replace(/^BUZZY_/, 'BEELINE_');
  const normalized = { ...previous };
  for (const [name, value] of Object.entries(previous)) {
    if (!name.startsWith('BUZZY_')) continue;
    normalized[canonicalName(name)] ??= value;
    delete normalized[name];
  }
  const passthrough = new Set(
    [previous.BUZZY_BODY_AGENT_ENV_PASSTHROUGH, previous.BEELINE_BODY_AGENT_ENV_PASSTHROUGH]
      .filter(Boolean).join(',').split(',').map(name => canonicalName(name.trim())).filter(Boolean),
  );
  passthrough.add('BEELINE_FREE_AGENT_MODEL_TOKEN');
  passthrough.add('AGENT_BROWSER_ENGINE');
  passthrough.add('AGENT_BROWSER_EXECUTABLE_PATH');
  passthrough.add('AGENT_BROWSER_SOCKET_DIR');
  normalized.AGENT_BROWSER_ENGINE = 'lightpanda';
  normalized.AGENT_BROWSER_EXECUTABLE_PATH = '/usr/local/bin/lightpanda';
  normalized.AGENT_BROWSER_SOCKET_DIR = '/tmp/beeline-browser';
  normalized.BEELINE_BODY_AGENT_ENV_PASSTHROUGH = [...passthrough].join(',');
  if (!normalized.BEELINE_FREE_AGENT_MODEL_TOKEN)
    throw new Error('free agent proxy configuration is missing');
  if (agentBehavior(runtime.agentKind).hostedModelConfig === 'inline-provider') {
    const provider = JSON.parse(previous.OPENCODE_CONFIG_CONTENT ?? '{}').provider?.beeline;
    if (!provider?.options?.baseURL) throw new Error('free agent proxy configuration is missing');
    const model = runtime.modelSelection?.model;
    if (!model?.startsWith('beeline/')) throw new Error('free agent proxy model is missing');
    const agent = await freeAgentPiCommand(env);
    await writePrivateFileAtomically(resolve(env.HOME ?? '/root', '.pi/agent/models.json'), freeAgentPiConfig({
      modelBaseUrl: provider.options.baseURL,
      upstreamModel: model.slice('beeline/'.length),
    }, await freeAgentInput(model.slice('beeline/'.length))));
    runtime.agentKind = agent.kind;
    runtime.agentCommand = agent.command;
    runtime.agentBinary = agent.command;
    runtime.agentArgs = agent.args;
    await writeRuntimeRecord(runtime);
    delete normalized.OPENCODE_CONFIG_CONTENT;
  } else {
    const path = resolve(env.HOME ?? '/root', '.pi/agent/models.json');
    const persisted = JSON.parse(await readFile(path, 'utf8').catch(() => '{}'));
    const provider = persisted.providers?.beeline;
    const model = runtime.modelSelection?.model;
    if (provider?.baseUrl && model?.startsWith('beeline/')) {
      const upstreamModel = model.slice('beeline/'.length);
      await writePrivateFileAtomically(path, freeAgentPiConfig({ modelBaseUrl: provider.baseUrl, upstreamModel },
        await freeAgentInput(upstreamModel)));
    }
  }
  const reconciled = `${Object.entries(normalized).map(([name, value]) => `${name}=${value}`).join('\n')}\n`;
  if (reconciled !== original) await writePrivateFileAtomically(runtime.llmEnvFile, reconciled);
}

export async function runFreeAgentCommand(env: NodeJS.ProcessEnv = process.env) {
  const startedAt = performance.now();
  const startupStep = (step: string) => console.info(`[free-agent] boot ${new Date().toISOString()} step=${step} elapsedMs=${Math.round(performance.now() - startedAt)}`);
  startupStep('command');
  const agentId = env.BEELINE_FREE_AGENT_ID?.trim().toLowerCase() ?? '';
  const serverUrl = env.BEELINE_SERVER_URL?.trim() ?? '';
  if (!/^[0-9a-f]{64}$/.test(agentId)) throw new Error('BEELINE_FREE_AGENT_ID is required');
  if (!/^https?:\/\//.test(serverUrl)) throw new Error('BEELINE_SERVER_URL is required');
  const supervisorRoot = defaultSupervisorRoot(env);
  const configPath = runtimeConfigPath(supervisorRoot, agentId);
  if (!(await hasDaemonToken(configPath))) {
    const token = env.BEELINE_FREE_AGENT_BOOTSTRAP?.trim();
    if (!token) throw new Error('BEELINE_FREE_AGENT_BOOTSTRAP is required for the first boot');
    // A first boot that died before activating left an exchange-only record.
    await rm(runtimeDirectory(supervisorRoot, agentId), { recursive: true, force: true });
    const grant = await fetchFreeAgentGrant(serverUrl, token);
    startupStep('bootstrap');
    if (grant.agentId !== agentId) throw new Error('free agent bootstrap returned another agent');
    await stageFreeAgent(env, grant);
    console.log(`[free-agent] staged agent ${agentId.slice(0, 12)} for ${grant.workspaceName}`);
  }
  startupStep('staged');
  await upgradeFreeAgentHarness(configPath, env);
  startupStep('harness');
  startupStep('helper-start');
  return runMachineHelper({
    configPaths: [configPath],
    env,
    freeAgent: true,
  });
}
