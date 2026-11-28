import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { prepareRoomAgentHome } from './agent-home.js';
import { machineCliProxyEndpoint } from './cliproxy.js';
import type { BodyConfig } from './config.js';
import { syncCornerBranch } from './corner-branch-sync.js';
import { installCornerGitHubWrappers } from './corner-github-auth.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { openRouterRoutingInput } from './openrouter-routing.js';
import type { SessionResources } from './session-resources.js';
import { runOwnedFile } from './wait.js';
import { githubGitEnv } from './workspace-checkout.js';

/** What a place session hands the home and branch helpers. */
export interface PlaceHomeInput {
  readonly config: BodyConfig;
  readonly placeId: string;
  readonly parentRoomId?: string;
  /** The session's private home now, when it has one; else the configured agent home is used. */
  readonly privateHomeRoot: () => string | undefined;
  readonly resources: SessionResources;
}

/** Prepare the agent home once optional configuration has loaded. */
export async function prepareOptionalHome(input: PlaceHomeInput): Promise<void> {
  const { config } = input;
  const homeRoot = input.privateHomeRoot() ?? config.agentHomeRoot;
  const configuration = input.resources.context.configuration;
  if (homeRoot)
    await prepareRoomAgentHome({
      root: homeRoot,
      failClosed: true,
      operatorHome: config.operatorHome,
      agentKind: config.agentKind,
      sharedSkills: config.sharedSkills,
      agentEnv: config.agentEnv,
      cliProxy: machineCliProxyEndpoint(),
      isReviewer: configuration?.isReviewer === true,
      ...openRouterRoutingInput(
        config,
        { model: configuration?.model ?? config.modelSelection?.model },
        undefined,
        {},
      ),
    });
  await prepareGitHubLaunchers(input);
}

/** Install the corner's git and gh wrappers in its agent home. */
export async function prepareGitHubLaunchers(input: PlaceHomeInput): Promise<void> {
  const { config, parentRoomId, placeId } = input;
  const homeRoot = input.privateHomeRoot() ?? config.agentHomeRoot;
  if (parentRoomId && config.runtimeConfigPath && homeRoot) {
    const which = (name: string) =>
      runOwnedFile('which', [name])
        .then((result) => String(result.stdout).trim())
        .catch(() => undefined);
    const gitBinary = await which('git');
    if (!gitBinary) throw new Error('git is not installed');
    await installCornerGitHubWrappers({
      root: homeRoot,
      runtimeConfigPath: config.runtimeConfigPath,
      roomId: parentRoomId,
      cornerId: placeId,
      cliEntrypoint: process.argv[1]!,
      gitBinary,
      ghBinary: await which('gh'),
      featureBranch:
        input.resources.context.restore?.featureBranch ??
        `feature/corner-${placeId.replaceAll('-', '').slice(0, 12)}`,
      targetBranch: input.resources.context.repository?.targetBranch || 'main',
      inheritedPath: config.agentEnv.PATH ?? process.env.PATH,
    });
  }
}

/** Another agent may have pushed this thread's branch; bring an existing
 * checkout onto it. A failure returns one line for the next prompt. */
export async function refreshFeatureBranch(input: {
  readonly api: DaemonApiClient;
  readonly folder: string;
  readonly placeId: string;
  readonly parentRoomId?: string;
  readonly resources: SessionResources;
}): Promise<string | undefined> {
  const { parentRoomId, placeId, api, folder } = input;
  if (!parentRoomId || !existsSync(resolve(folder, '.git'))) return undefined;
  const branch =
    input.resources.context.restore?.featureBranch ??
    `feature/corner-${placeId.replaceAll('-', '').slice(0, 12)}`;
  try {
    const remote = (await runOwnedFile('git', ['-C', folder, 'remote', 'get-url', 'origin'])).stdout
      .toString()
      .trim();
    const env = remote.startsWith('file://')
      ? undefined
      : githubGitEnv((await api.execute('getRoomGitHubToken', { roomId: parentRoomId })).token);
    await syncCornerBranch({
      worktreePath: folder,
      featureBranch: branch,
      ...(env ? { env } : {}),
    });
    return undefined;
  } catch (error) {
    return `Your branch ${branch} could not be refreshed from origin (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); fetch and sync it yourself before relying on it.`;
  }
}
