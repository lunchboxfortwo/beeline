import {
  activateRelease,
  defaultBeelineInstallLayout,
  hostPlatformKey,
  readInstalledBundleIdentity,
  resolveBundleEntrypoint,
} from './self-update.js';
import { resolve } from 'node:path';
import { readPublishedBundle } from './self-update-manifest.js';
import { prepareMachineRelease } from './recovery.js';
import { withInstallLock } from './managed-update.js';
import type { AgentAccessPolicy } from './access-policy.js';
import {
  AUTO_DETECT_AGENT_KINDS,
  type AgentKind,
  type AgentCommand,
  installLatestAgentAdapter,
  requireInstalledAgentProgram,
  resolveAgentCommand,
  installedAgentProgramEnvironment,
  agentBehavior,
} from './agent-command.js';
import { stdin, stdout } from 'node:process';
import { fstatSync } from 'node:fs';
import {
  type ProviderKeyProvider,
  readSavedProviderKey,
  saveProviderKey,
  providerKeyFromEnvironment,
  maskProviderKey,
  PROVIDER_KEY_ENV_VARS,
} from './provider-key-store.js';
import { clackPromptOutput, unwrapPrompt } from './clack-support.js';
import * as clack from '@clack/prompts';
import { fetchAgentModelCatalog } from './model-catalog.js';
import { enumerateCursorModels } from './cursor-models.js';
import { verifyProviderKey, type ConnectKeyProvider } from './provider-key-check.js';
import {
  runConnectWizard,
  providerEnvironment,
  brassSpinner,
  type SpinnerStep,
} from './connect-command-parse-connect-subscriptions.js';
import { ask } from './wait.js';

export const CONNECT_HARNESSES = AUTO_DETECT_AGENT_KINDS;

export const AGENT_NAME_MAX_LENGTH = 32;

/**
 * Connect needs a keyboard-backed input stream and an output someone reads.
 * Some mobile terminal shells proxy stdout through their UI, so it is writable
 * but does not identify as a TTY; that pipe still reaches a person who can
 * answer every prompt. Stdout redirected to a file or a device such as
 * /dev/null reaches nobody, and the prompts would wait blind.
 */
export function isInteractiveConnectTerminal(
  input: Pick<NodeJS.ReadStream, 'isTTY'> = stdin,
  output: { isTTY?: boolean; fd?: number } = stdout,
): boolean {
  if (input.isTTY !== true) return false;
  if (output.isTTY === true || output.fd === undefined) return true;
  try {
    const target = fstatSync(output.fd);
    return !target.isFile() && !target.isCharacterDevice();
  } catch {
    return true;
  }
}

export function isReasonableAgentName(value: string): boolean {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return (
    normalized.length > 0 &&
    normalized.length <= AGENT_NAME_MAX_LENGTH &&
    /^\p{L}[\p{L}\p{M}'’ -]*$/u.test(normalized)
  );
}

export const CONNECT_PROVIDER_HARNESSES = new Set<AgentKind>(['goose', 'pi']);

export const CONNECT_PROVIDERS = ['openrouter', 'openai', 'anthropic', 'google', 'xai'] as const;

export type ConnectProvider = (typeof CONNECT_PROVIDERS)[number];

/** Saved-key access seam so tests can stub the on-disk store. */
export interface ConnectKeyStore {
  read(provider: ConnectProvider): Promise<string | undefined>;
  save(provider: ConnectProvider, key: string): Promise<void>;
}

export const fileConnectKeyStore: ConnectKeyStore = {
  read: (provider: ProviderKeyProvider) => readSavedProviderKey(provider),
  save: (provider: ProviderKeyProvider, key: string) => saveProviderKey(provider, key),
};

export const DEFAULT_MODELS: Record<
  ConnectProvider | 'codex' | 'claude' | 'grok' | 'cursor' | 'opencode',
  string
> = {
  openrouter: 'z-ai/glm-5.3-flash',
  openai: 'gpt-5.4',
  anthropic: 'claude-opus-4-1',
  google: 'gemini-2.5-pro',
  xai: 'grok-4',
  codex: 'gpt-5.4',
  claude: 'claude-opus-4-1',
  grok: 'grok-4',
  // cursor-agent's own default; always served, and the only model safe to
  // assume before `cursor-agent models` has been read.
  cursor: 'auto',
  opencode: 'opencode/big-pickle',
};

/**
 * What the wizard still asks for. Name and soul are NOT here: the server seeds
 * both from the animal it assigns the agent, so nobody types them.
 */
export interface ConnectWizardResult {
  harness: (typeof CONNECT_HARNESSES)[number];
  provider?: ConnectProvider;
  apiKey?: string;
  model: string;
  /** Only set when the harness advertises a reasoning-effort axis to choose from. */
  effort?: string;
}

export interface ConnectPrompts {
  select<T extends string>(input: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValue?: T;
  }): Promise<T>;
  autocomplete(input: {
    message: string;
    options: Array<{ value: string; label: string }>;
    initialValue?: string;
    placeholder?: string;
    maxItems?: number;
  }): Promise<string>;
  text(input: {
    message: string;
    initialValue?: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;
  password(input: {
    message: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;
}

export function connectHarnessNeedsProvider(harness: AgentKind): boolean {
  return CONNECT_PROVIDER_HARNESSES.has(harness);
}

export function defaultConnectModel(
  harness: (typeof CONNECT_HARNESSES)[number],
  provider?: ConnectProvider,
): string {
  return provider
    ? DEFAULT_MODELS[provider]
    : (DEFAULT_MODELS[harness as 'codex' | 'claude' | 'grok' | 'cursor' | 'opencode'] ?? 'default');
}

export function brassEnabled(
  env: NodeJS.ProcessEnv,
  output: NodeJS.WriteStream,
): 'truecolor' | '256' | 'plain' {
  if (env.NO_COLOR !== undefined || !output.isTTY) return 'plain';
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? '')) return 'truecolor';
  if (/256color/i.test(env.TERM ?? '')) return '256';
  return 'plain';
}

/** The one brand brass, #D7AF5F — the app's accent, and xterm 179 exactly. */
export const BRASS_TRUECOLOR = '\u001b[38;2;215;175;95m';

export const BRASS_256 = '\u001b[38;5;179m';

export function brass(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
  output: NodeJS.WriteStream = stdout,
): string {
  const level = brassEnabled(env, output);
  if (level === 'truecolor') return `${BRASS_TRUECOLOR}${value}\u001b[39m`;
  if (level === '256') return `${BRASS_256}${value}\u001b[39m`;
  return value;
}

/**
 * Clack paints its rails — the active step symbol, the selected option, the
 * submitted value — cyan, and there is no colour hook to ask it otherwise.
 * Repaint that one colour brass on the way out so the wizard reads as the app
 * does. Nothing else about the frame changes.
 */
export function brassRails(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  output: NodeJS.WriteStream = stdout,
): string {
  const level = brassEnabled(env, output);
  if (level === 'plain') return text;
  return text.replace(/\u001b\[(?:36|96)m/g, level === 'truecolor' ? BRASS_TRUECOLOR : BRASS_256);
}

/** Hold the repaint for the life of the wizard; the return restores the stream. */
export function paintWizardBrass(output: NodeJS.WriteStream = stdout): () => void {
  const original = output.write;
  const patched = function write(this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]) {
    return (original as unknown as (...args: unknown[]) => boolean).call(
      this,
      typeof chunk === 'string' ? brassRails(chunk, process.env, output) : chunk,
      ...rest,
    );
  };
  output.write = patched as unknown as NodeJS.WriteStream['write'];
  return () => {
    output.write = original;
  };
}

export const clackPrompts: ConnectPrompts = {
  async select<T extends string>(input: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValue?: T;
  }) {
    clackPromptOutput();
    return unwrapPrompt(
      await clack.select<T>(input as clack.SelectOptions<T>),
      'Connection cancelled.',
    );
  },
  async autocomplete(input: {
    message: string;
    options: Array<{ value: string; label: string }>;
    initialValue?: string;
    placeholder?: string;
    maxItems?: number;
  }) {
    clackPromptOutput();
    return unwrapPrompt(
      await clack.autocomplete<string>({ ...input, output: clackPromptOutput() }),
      'Connection cancelled.',
    );
  },
  async text(input) {
    clackPromptOutput();
    return unwrapPrompt(
      await clack.text({
        ...input,
        validate: input.validate ? (value) => input.validate!(value ?? '') : undefined,
      }),
      'Connection cancelled.',
    );
  },
  async password(input) {
    clackPromptOutput();
    return unwrapPrompt(
      await clack.password({
        ...input,
        validate: input.validate ? (value) => input.validate!(value ?? '') : undefined,
      }),
      'Connection cancelled.',
    );
  },
};

export type ConnectAxisPicker = {
  currentValue?: string;
  options: Array<{ id: string; name?: string }>;
};

export type ConnectModelCatalog = ConnectAxisPicker & {
  note?: string;
  /** The harness's reasoning-effort axis, when it advertises one. */
  effort?: ConnectAxisPicker;
};

/**
 * The categories a harness spells its reasoning-effort axis with. Codex says
 * `effort`, Claude says `thought_level`, others say `reasoning_effort`; all
 * three are the same question to a person.
 */
export const CONNECT_EFFORT_CATEGORIES = ['effort', 'reasoning_effort', 'thought_level'];

/**
 * The effort picker, from the safe view when it kept the axis and the raw
 * advertised axes otherwise. A harness with no such axis has nothing to ask
 * about, so the wizard skips the question rather than inventing a ladder.
 */
export function connectEffortPickerFromAxes(
  axes: Array<{ category: string; currentValue?: string; options: Array<{ id: string }> }>,
  rawAxes = axes,
): ConnectAxisPicker | undefined {
  const isEffort = (axis: { category: string; options: Array<{ id: string }> }): boolean =>
    CONNECT_EFFORT_CATEGORIES.includes(axis.category) && axis.options.length > 0;
  const axis =
    axes.find((axis) => CONNECT_EFFORT_CATEGORIES.includes(axis.category)) ??
    rawAxes.find(isEffort);
  return axis?.options.some((choice) => choice.id !== 'off')
    ? { currentValue: axis.currentValue, options: axis.options }
    : undefined;
}

/**
 * Derive the wizard's model picker from the harness's advertised axes —
 * never a hard failure. Prefer the catalog authority's safe view, retaining
 * the raw advertised axis as a defensive fallback for adapters whose routed
 * model identifiers cannot be classified generically. If the harness truly
 * enumerated nothing, the provider default is offered with an explanatory
 * note. The old behavior — throwing "did not advertise any available models"
 * — refused connect runs that were fully serviceable.
 */
export function connectModelPickerFromAxes(
  axes: Array<{ category: string; currentValue?: string; options: Array<{ id: string }> }>,
  fallbackModel: string,
  harness: string,
  rawAxes = axes,
): ConnectModelCatalog {
  const filtered = axes.find((axis) => axis.category === 'model');
  if (filtered?.options.length) {
    return { currentValue: filtered.currentValue, options: filtered.options };
  }
  const raw = rawAxes.find((axis) => axis.category === 'model' && axis.options.length);
  if (raw) {
    return { currentValue: raw.currentValue, options: raw.options };
  }
  return {
    currentValue: fallbackModel,
    options: [{ id: fallbackModel }],
    note: `${harness} did not enumerate models; offering the provider default`,
  };
}

export interface ConnectModelCatalogRequest {
  harness: ConnectWizardResult['harness'];
  provider?: ConnectProvider;
  apiKey?: string;
  /**
   * Read the catalog as this model rather than the provider default. Effort
   * ladders can be model-specific, so the wizard re-reads under the model the
   * person just picked before asking what effort it should run at.
   */
  model?: string;
  /** Aborted when the person cancels; no adapter is started after that. */
  signal?: AbortSignal;
  /** Where the adapter refresh's own decision and progress lines go. */
  say?: (line: string) => void;
}

export interface ConnectModelCatalogDependencies {
  refreshAdapter?: (
    kind: AgentKind,
    options?: { log?: (line: string) => void; signal?: AbortSignal },
  ) => Promise<unknown>;
  resolveAgent?: (kind: AgentKind) => Pick<AgentCommand, 'kind' | 'command' | 'args'>;
  fetchCatalog?: typeof fetchAgentModelCatalog;
}

export const refreshedConnectAdapters = new Map<AgentKind, Promise<unknown>>();

export function refreshConnectAdapter(
  kind: AgentKind,
  options: { log?: (line: string) => void; signal?: AbortSignal } = {},
): Promise<unknown> {
  const existing = refreshedConnectAdapters.get(kind);
  if (existing) return existing;
  const refresh = installLatestAgentAdapter(kind, options).catch((error) => {
    refreshedConnectAdapters.delete(kind);
    throw error;
  });
  refreshedConnectAdapters.set(kind, refresh);
  return refresh;
}

export async function loadConnectModelCatalog(
  input: ConnectModelCatalogRequest,
  dependencies: ConnectModelCatalogDependencies = {},
): Promise<ConnectModelCatalog> {
  if (!dependencies.resolveAgent) requireInstalledAgentProgram(input.harness);
  // Resolve only after the refresh. Otherwise the wizard can interrogate an
  // old adapter, persist its model id, then launch a different adapter from a
  // later PATH resolution. A picker choice must come from the exact command
  // that connect-finish will store for the daemon.
  await (dependencies.refreshAdapter ?? refreshConnectAdapter)(input.harness, {
    ...(input.say ? { log: input.say } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (input.signal?.aborted) throw new Error('Connection cancelled.');
  const agent = (dependencies.resolveAgent ?? ((kind) => resolveAgentCommand({ kind })))(
    input.harness,
  );
  const model = input.model ?? defaultConnectModel(input.harness, input.provider);
  const catalog = await (dependencies.fetchCatalog ?? fetchAgentModelCatalog)(
    agent,
    {
      ...installedAgentProgramEnvironment(input.harness),
      ...providerEnvironment({
        harness: input.harness,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.apiKey ? { apiKey: input.apiKey } : {}),
        model,
      }),
    },
    input.model ? { model: input.model } : undefined,
    input.signal,
  );
  input.signal?.throwIfAborted();
  const effort = connectEffortPickerFromAxes(catalog.catalog, catalog.raw);
  const picker = connectModelPickerFromAxes(
    catalog.catalog,
    defaultConnectModel(input.harness, input.provider),
    input.harness,
    catalog.raw,
  );
  // cursor-agent advertises models through Beeline's ACP bridge at
  // `session/new`; this CLI read remains the fallback when that catalog is empty.
  if (
    agentBehavior(input.harness).cliModelCatalog &&
    !catalog.catalog.some((axis) => axis.category === 'model' && axis.options.length) &&
    !catalog.raw.some((axis) => axis.category === 'model' && axis.options.length)
  ) {
    const cliModels = await enumerateCursorModels(process.env, input.signal);
    if (cliModels) return { ...cliModels, ...(effort ? { effort } : {}) };
  }
  return {
    ...picker,
    ...(effort ? { effort } : {}),
  };
}

/**
 * A catalog is evidence that a harness is already configured only when the
 * harness itself enumerated models. `connectModelPickerFromAxes` synthesises
 * a one-entry picker with a `note` when it enumerated nothing; that entry is
 * the provider default, which is exactly what the wizard must not mistake for
 * an observation.
 */
export function connectProbeFoundModels(catalog: ConnectModelCatalog): boolean {
  return catalog.note === undefined && catalog.options.length > 0;
}

export function connectHarnessLabel(harness: (typeof CONNECT_HARNESSES)[number]): string {
  return agentBehavior(harness).label ?? harness[0]!.toUpperCase() + harness.slice(1);
}

export interface ConnectWizardSeams {
  checkProgram?: (kind: AgentKind, env: NodeJS.ProcessEnv) => void;
  /** Where the wizard says what it found instead of asking for it. */
  announce?: (line: string) => void;
}

/**
 * Ask before assuming — except about what the agent will think with. Setup
 * facts the machine can establish it establishes: it checks the chosen harness
 * before asking for its provider and key (asked only when
 * the harness holds none; a harness that answers `session/new` with its own
 * model list is authenticated by definition). Model and reasoning effort are
 * always asked, including of an already-configured harness: the harness's
 * current selection is the default offered, never a silent answer. It used to
 * be taken as one, which left people connected to whatever their harness
 * happened to be set to with no say and no way back but the app.
 */
export async function collectConnectWizard(
  prompts: ConnectPrompts = clackPrompts,
  loadModels: (
    input: ConnectModelCatalogRequest,
  ) => Promise<ConnectModelCatalog> = loadConnectModelCatalog,
  keyStore: ConnectKeyStore = fileConnectKeyStore,
  env: NodeJS.ProcessEnv = process.env,
  verifyKey: (
    input: { provider: ConnectProvider; apiKey: string },
    step?: SpinnerStep,
  ) => Promise<void> = (input, step) =>
    verifyProviderKey({
      ...(input as { provider: ConnectKeyProvider; apiKey: string }),
      ...(step ? { signal: step.signal } : {}),
    }),
  seams: ConnectWizardSeams = {},
): Promise<ConnectWizardResult> {
  const announce = seams.announce ?? ((line: string) => clack.log.info(brass(line)));
  const askModel = async (
    catalog: ConnectModelCatalog,
    forHarness: (typeof CONNECT_HARNESSES)[number],
    forProvider?: ConnectProvider,
  ): Promise<string> => {
    const initialModel = catalog.currentValue ?? defaultConnectModel(forHarness, forProvider);
    const picked = await prompts.autocomplete({
      message: brass(catalog.note ? `Choose model (${catalog.note})` : 'Choose model'),
      options: catalog.options.map((choice) => ({
        value: choice.id,
        label: choice.name ? `${choice.name} (${choice.id})` : choice.id,
      })),
      ...(catalog.options.some((choice) => choice.id === initialModel)
        ? { initialValue: initialModel }
        : {}),
      placeholder: 'Type to filter available models…',
      maxItems: 12,
    });
    return (picked ?? '').trim();
  };
  /**
   * Reasoning effort, asked whenever the harness advertises the axis. Ladders
   * can be model-specific, so a model other than the one the catalog was read
   * under earns one more read: the ladder offered is then the chosen
   * model's own, and the value cannot be refused later by the session that
   * validates it. Without that model's own axis, skip the question.
   */
  const askEffort = async (
    catalog: ConnectModelCatalog,
    forHarness: (typeof CONNECT_HARNESSES)[number],
    model: string,
    forProvider?: ConnectProvider,
    forKey?: string,
  ): Promise<string | undefined> => {
    let axis = catalog.effort;
    if (model !== catalog.currentValue) {
      const reread = await brassSpinner(
        `Reading ${model}'s effort options…`,
        ({ signal, say }) =>
          loadModels({
            harness: forHarness,
            model,
            ...(forProvider ? { provider: forProvider } : {}),
            ...(forKey ? { apiKey: forKey } : {}),
            signal,
            say,
          }).catch(() => undefined),
        () => undefined,
        undefined,
      );
      axis = reread?.effort;
    }
    if (!axis?.options.some((choice) => choice.id !== 'off')) return undefined;
    const picked = await prompts.select<string>({
      message: brass('Choose reasoning effort'),
      options: axis.options.map((choice) => ({
        value: choice.id,
        label: choice.name ?? choice.id,
        ...(choice.id === axis.currentValue ? { hint: 'current' } : {}),
      })),
      ...(axis.options.some((choice) => choice.id === axis.currentValue)
        ? { initialValue: axis.currentValue! }
        : {}),
    });
    return (picked ?? '').trim();
  };
  // One attempt, and never a hard failure: a harness that refuses, crashes or
  // exits is simply one the wizard has to ask about. The read waits only for
  // the adapter's answers or its exit, and it can take several seconds
  // (claude-agent-acp live-validates every advertised model), so a spinner
  // covers it; without one the wizard sits at "Choose harness" and reads as
  // hung. Cancelling stops the adapter (`brassSpinner`).
  const probe = (
    candidate: (typeof CONNECT_HARNESSES)[number],
  ): Promise<ConnectModelCatalog | undefined> =>
    brassSpinner(
      `Checking ${connectHarnessLabel(candidate)}…`,
      ({ signal, say }) =>
        loadModels({ harness: candidate, signal, say }).then(
          (catalog) => (connectProbeFoundModels(catalog) ? catalog : undefined),
          () => undefined,
        ),
      () => undefined,
      undefined,
    );
  const checkKey = (forProvider: ConnectProvider, key: string, label: string) =>
    brassSpinner(
      `Checking the ${label} key…`,
      (step) => verifyKey({ provider: forProvider, apiKey: key }, step),
      () => `${label} accepted the key`,
    );

  // Resolving a harness can launch its program. Leave that to the selected harness's model probe.
  const harness = await prompts.select<(typeof CONNECT_HARNESSES)[number]>({
    message: brass('Choose harness'),
    options: CONNECT_HARNESSES.map((value) => ({ value, label: connectHarnessLabel(value) })),
  });
  const checkProgram = seams.checkProgram ?? requireInstalledAgentProgram;
  checkProgram(harness, env);
  const configured = await probe(harness);
  if (configured) {
    const runningModel = configured.currentValue ? `, running ${configured.currentValue}` : '';
    announce(`${connectHarnessLabel(harness)} is already set up${runningModel}.`);
    // What the harness is set to is the default, not the decision: both
    // questions are still asked, with its own current values pre-selected.
    const model = await askModel(configured, harness);
    const effort = await askEffort(configured, harness, model);
    return { harness, model, ...(effort ? { effort } : {}) };
  }
  let provider: ConnectProvider | undefined;
  let apiKey: string | undefined;
  if (connectHarnessNeedsProvider(harness)) {
    provider = await prompts.select<ConnectProvider>({
      message: brass('Choose provider'),
      initialValue: 'openrouter',
      options: CONNECT_PROVIDERS.map((value) => ({
        value,
        label: value === 'openrouter' ? 'OpenRouter' : value[0]!.toUpperCase() + value.slice(1),
        ...(value === 'openrouter' ? { hint: 'default' } : {}),
      })),
    });
    const providerLabel = provider === 'openrouter' ? 'OpenRouter' : provider;
    const savedKey = await keyStore.read(provider);
    const envKey = providerKeyFromEnvironment(provider, env);
    const availableKey = savedKey ?? envKey;
    if (availableKey) {
      const masked = maskProviderKey(availableKey);
      const choice = await prompts.select<'saved' | 'new'>({
        message: brass(`${providerLabel} API key`),
        initialValue: 'saved',
        options: [
          {
            value: 'saved',
            label: savedKey
              ? `Use saved ${providerLabel} key (${masked})`
              : `Use ${PROVIDER_KEY_ENV_VARS[provider]} from the environment (${masked})`,
          },
          { value: 'new', label: 'Enter a new key' },
        ],
      });
      if (choice === 'saved') {
        apiKey = availableKey;
        await checkKey(provider, apiKey, providerLabel);
      } else {
        apiKey = await prompts.password({
          message: brass(`${providerLabel} API key`),
          validate: (value) => (value.trim() ? undefined : 'API key is required'),
        });
        apiKey = apiKey.trim();
        await checkKey(provider, apiKey, providerLabel);
        await keyStore.save(provider, apiKey);
      }
    } else {
      apiKey = await prompts.password({
        message: brass(`${providerLabel} API key`),
        validate: (value) => (value.trim() ? undefined : 'API key is required'),
      });
      apiKey = apiKey.trim();
      await checkKey(provider, apiKey, providerLabel);
      await keyStore.save(provider, apiKey);
    }
  }
  // The wizard is committed to this harness now: the read waits for the
  // adapter's answers or its exit, and a failed one is reported rather than
  // swallowed.
  const catalog = await brassSpinner(
    `Reading ${connectHarnessLabel(harness)} models…`,
    ({ signal, say }) =>
      loadModels({
        harness,
        ...(provider ? { provider } : {}),
        ...(apiKey ? { apiKey: apiKey.trim() } : {}),
        signal,
        say,
      }),
    () => undefined,
  );
  const model = await askModel(catalog, harness, provider);
  const effort = await askEffort(catalog, harness, model, provider, apiKey?.trim());
  return {
    harness,
    ...(provider ? { provider } : {}),
    ...(apiKey ? { apiKey: apiKey.trim() } : {}),
    model,
    ...(effort ? { effort } : {}),
  };
}

export interface DeviceGrantResponse {
  agent_secret_key: string;
  agent_pubkey: string;
  body_secret_key: string;
  daemon_exchange_token: string;
  agent_name: string;
  agent_face?: string;
  workspace_id: string;
  workspace_name: string;
  workspace_joined: boolean;
  paired_by: string;
  harness: ConnectWizardResult['harness'];
  provider?: ConnectProvider;
  model: string;
  effort?: string;
  soul: string;
}

/**
 * One wizard POST through `ask` that aborts when the person cancels.
 */
export async function jsonRequest<T>(
  url: string,
  body: unknown,
  fetchImpl: typeof fetch,
  step?: SpinnerStep,
): Promise<T> {
  const response = await ask(
    { url, fetch: fetchImpl },
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(step ? { signal: step.signal } : {}),
    },
  );
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new Error(detail.message ?? detail.error ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function installCurrentRelease(
  fetchImpl: typeof fetch,
  step?: SpinnerStep,
): Promise<{ binary: string; version: string }> {
  step?.signal.throwIfAborted();
  const layout = defaultBeelineInstallLayout(process.env);
  const binary = resolve(layout.binDir, 'beeline');
  // Connecting only needs the installed CLI. The serving helper owns its own
  // release channel and update lifecycle, independently of this npm bundle.
  const installed = await resolveBundleEntrypoint(layout.libDir);
  step?.signal.throwIfAborted();
  if (installed) {
    const version = (await readInstalledBundleIdentity(layout))?.version ?? 'unknown';
    step?.signal.throwIfAborted();
    return { binary, version };
  }
  const manifest = await readPublishedBundle(hostPlatformKey(), { fetchImpl, signal: step?.signal });
  step?.signal.throwIfAborted();
  const { releaseId } = await prepareMachineRelease(layout, {
    manifest,
    fetchImpl,
    logger: step?.say ?? (() => {}),
    ...(step ? { signal: step.signal } : {}),
  });
  step?.signal.throwIfAborted();
  await withInstallLock(layout, () => {
    step?.signal.throwIfAborted();
    return activateRelease(layout, releaseId, step ? { signal: step.signal } : {});
  });
  return {
    binary,
    version: manifest.bundle.version ?? releaseId,
  };
}

export async function runConnectCommand(
  code: string | undefined,
  options: {
    fetchImpl?: typeof fetch;
    subscribe?: readonly string[];
    accessPolicy?: AgentAccessPolicy;
  } = {},
): Promise<void> {
  if (!isInteractiveConnectTerminal()) {
    throw new Error('`usebeeline connect` needs an interactive terminal');
  }
  const restoreRails = paintWizardBrass();
  try {
    await runConnectWizard(
      code,
      options.fetchImpl ?? fetch,
      options.subscribe ?? [],
      options.accessPolicy,
    );
  } finally {
    restoreRails();
  }
}
export { parseConnectSubscriptions } from './connect-command-parse-connect-subscriptions.js';
export { readMachineId } from './connect-command-parse-connect-subscriptions.js';
export { requestConnectGrant } from './connect-command-parse-connect-subscriptions.js';
export { renameConnectedAgent } from './connect-command-parse-connect-subscriptions.js';
export { finishConnectedAgentPairing } from './connect-command-parse-connect-subscriptions.js';
export { seededIdentityLine } from './connect-command-parse-connect-subscriptions.js';
export { brassSpinner } from './connect-command-parse-connect-subscriptions.js';
export { confirmSeededName } from './connect-command-parse-connect-subscriptions.js';
export { connectPlainFailure } from './connect-command-parse-connect-subscriptions.js';
export { ConnectFailureError } from './connect-command-parse-connect-subscriptions.js';
export { runConnectFinishCommand } from './connect-command-parse-connect-subscriptions.js';
