/**
 * The Fly Machines API calls the free starter agents need: one Machine per
 * agent in one Fly app. Every call is a plain HTTPS request with the app's
 * scoped token; nothing here keeps state.
 */
export interface FreeAgentMachineSpec {
  /** Stable lookup key: the agent identity this Machine hosts. */
  agentId: string;
  image: string;
  region: string;
  env: Record<string, string>;
  cpus: number;
  memoryMb: number;
}

export interface FreeAgentMachine {
  id: string;
  state: string;
  instance_id?: string;
  config: Record<string, unknown> & { image: string };
}

export function sameMachineImage(actual: string, desired: string): boolean {
  return actual === desired || (desired.includes('@sha256:') && actual.split('@')[1] === desired.split('@')[1]);
}

export interface FreeAgentMachines {
  /** Create and boot one Machine; returns its Fly id. */
  create(spec: FreeAgentMachineSpec): Promise<{ id: string }>;
  /** The Machine already created for this agent, if any. */
  find(agentId: string): Promise<FreeAgentMachine | undefined>;
  /** Start a stopped Machine or resume a suspended one. */
  start(id: string, image?: string): Promise<FreeAgentMachine | void>;
  read(id: string): Promise<FreeAgentMachine | undefined>;
  reconnect(): FreeAgentMachines;
  /** Boot a stopped or outdated Machine now; its helper will suspend when ready. */
  refresh(id: string, image: string, force?: boolean): Promise<boolean>;
  suspend(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  /** Current Fly state (`started`, `suspended`, `stopped`, ...), or undefined when gone. */
  state(id: string): Promise<string | undefined>;
  /** Resolve once the Machine reaches `state` (Fly's own wait), or reject after the timeout. */
  waitFor(id: string, state: 'suspended' | 'stopped', timeoutSeconds: number, instanceId?: string): Promise<void>;
}

export class FlyApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly operation: string,
  ) {
    super(`Fly ${operation} failed: HTTP ${status} ${body.slice(0, 300)}`);
    this.name = 'FlyApiError';
  }
}

export class FlyMachines implements FreeAgentMachines {
  readonly #base: string;

  constructor(
    private readonly token: string,
    readonly app: string,
    private readonly fetchImpl: typeof fetch = fetch,
    apiOrigin = 'https://api.machines.dev',
    private readonly freshConnection = false,
  ) {
    this.#base = `${apiOrigin.replace(/\/$/, '')}/v1/apps/${encodeURIComponent(app)}/machines`;
  }

  async create(spec: FreeAgentMachineSpec): Promise<{ id: string }> {
    const machine = await this.#request<{ id: string }>('create', '', 'POST', {
      name: `free-agent-${spec.agentId.slice(0, 16)}-${Date.now().toString(36)}`,
      region: spec.region,
      config: {
        image: spec.image,
        env: spec.env,
        guest: { cpu_kind: 'shared', cpus: spec.cpus, memory_mb: spec.memoryMb },
        // The agent's files and the helper's state live on the root
        // filesystem; keeping it across stop/start removes the need for a volume.
        rootfs: { persist: 'always' },
        // The server decides when this Machine runs. A crash stays down until
        // the next wake starts it again.
        restart: { policy: 'no' },
        metadata: { beeline_agent: spec.agentId },
      },
    });
    return { id: machine.id };
  }

  async find(agentId: string): Promise<FreeAgentMachine | undefined> {
    const machines = await this.#request<FreeAgentMachine[]>(
      'list',
      `?metadata.beeline_agent=${encodeURIComponent(agentId)}`,
      'GET',
    );
    return machines.find((machine) => machine.state !== 'destroyed');
  }

  /** One fresh config read and one launch-enabled mutation. Fly owns preparation and launch. */
  async start(id: string, image?: string): Promise<FreeAgentMachine | void> {
    if (!image) { await this.#request('start', `/${id}/start`, 'POST', {}); return; }
    return (await this.#acquire(id, image)).machine;
  }

  async #acquire(id: string, image: string): Promise<{ changed: boolean; machine: FreeAgentMachine }> {
    const machine = await this.read(id);
    if (!machine) throw new FlyApiError(404, '', 'get');
    if (!sameMachineImage(machine.config.image, image)) {
      const updated = await this.#request<FreeAgentMachine>('update image', `/${id}`, 'POST', {
        current_version: machine.instance_id,
        skip_launch: false,
        config: { ...machine.config, image },
      });
      return { changed: true, machine: { ...machine, ...updated, config: { ...machine.config, image } } };
    }
    if (machine.state === 'stopped' || machine.state === 'suspended') {
      await this.#request('start', `/${id}/start`, 'POST', {});
      return { changed: true, machine };
    }
    return { changed: false, machine };
  }

  async suspend(id: string): Promise<void> {
    await this.#request('suspend', `/${id}/suspend`, 'POST', {});
  }

  async refresh(id: string, image: string): Promise<boolean> {
    return (await this.#acquire(id, image)).changed;
  }

  reconnect(): FlyMachines {
    // A new transport exchange, with no mutation replay or cached state.
    return new FlyMachines(this.token, this.app, this.fetchImpl, this.#base.split('/v1/apps/')[0], true);
  }

  async read(id: string): Promise<FreeAgentMachine | undefined> {
    try { return await this.#request<FreeAgentMachine>('get', `/${id}`, 'GET'); }
    catch (error) { if (error instanceof FlyApiError && error.status === 404) return undefined; throw error; }
  }

  async stop(id: string): Promise<void> {
    await this.#request('stop', `/${id}/stop`, 'POST', {});
  }

  async destroy(id: string): Promise<void> {
    try {
      await this.#request('destroy', `/${id}?force=true`, 'DELETE');
    } catch (error) {
      if (error instanceof FlyApiError && error.status === 404) return;
      throw error;
    }
  }

  async waitFor(id: string, state: 'suspended' | 'stopped', timeoutSeconds: number, instanceId?: string): Promise<void> {
    const instance = instanceId ? `&instance_id=${encodeURIComponent(instanceId)}` : '';
    await this.#request('wait', `/${id}/wait?state=${state}&timeout=${timeoutSeconds}${instance}`, 'GET');
  }

  async state(id: string): Promise<string | undefined> {
    return (await this.read(id))?.state;
  }

  async #request<T = unknown>(
    operation: string,
    path: string,
    method: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.#base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(this.freshConnection ? { connection: 'close' } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),

    });
    const text = await response.text();
    if (!response.ok) throw new FlyApiError(response.status, text, operation);
    return (text ? JSON.parse(text) : {}) as T;
  }
}
