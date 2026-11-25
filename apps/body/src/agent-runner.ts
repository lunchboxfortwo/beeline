import { randomUUID } from 'node:crypto';
import type { AgentCommand, AgentInvocation, AgentPlaceReset } from '@beeline/api-contract/daemon';
import { isBackgroundCommand } from '@beeline/api-contract/daemon';
import { dirname, resolve } from 'node:path';
import { resolveSessionIdleMs } from './agent-process.js';
import { answer } from './wait.js';
import { AnswerStore, type StoredAnswer } from './answer-store.js';
import { writePrivateFileAtomically } from './atomic-private-file.js';
import type { BodyConfig } from './config.js';
import { captureConnectionUsage, ConnectorUsageRecorder } from './connector-runner.js';
import { DaemonApiError, isAgentRemovedError, type DaemonApiClient } from './daemon-api-client.js';
import { GrantCommandRunner, GrantRunnerServer, type GrantRunnerEndpoint } from './grant-runner.js';
import { mergeHarnessTurnMetrics } from './harness-turn-tokens.js';
import { openRouterRoutingCacheDir } from './openrouter-routing.js';
import { PlaceSession, type Answer } from './place-session.js';
import { PlaceStorage } from './place-storage.js';
import { runtimeIdentity, type AgentRuntimeRecord } from './runtime.js';
import { publishStorageFacts } from './storage-owners.js';
import { distillTurnFailureReason, redactToolDetail } from './turn-failure-reason.js';
import { TurnTrace, turnTraceDirectory } from './turn-trace.js';
import { workspaceAssetRoot } from './workspace-assets.js';
import { prepareWorkspace } from './workspace-checkout.js';

const SESSION_IDLE_MS = resolveSessionIdleMs();

function isCancelledTurn(error: unknown): boolean {
  return error instanceof DaemonApiError && error.status === 409 && error.code === 'command turn cancelled';
}

interface Place {
  session: PlaceSession;
  resetId?: string;
  waiting: AgentCommand[];
  running?: AgentCommand;
  /** The running item from its turn start request until its harness returns. */
  turnStarted?: AgentCommand;
  idleTimer?: NodeJS.Timeout;
}

/**
 * The items one prompt answers: the head and the waiting input after it, up
 * to a schedule boundary. Tools act for the head's request, so a schedule batched
 * behind other input would open its threads and replies under that input's
 * request and instructions. A schedule joins a batch only behind a run of the
 * same schedule.
 */
function turnBatch(item: AgentCommand, waiting: readonly AgentCommand[]): AgentCommand[] {
  const batch = [item];
  const schedule = item.reason === 'schedule' ? item.scheduleId : undefined;
  for (const next of waiting) {
    if (next.reason === 'schedule' && (!schedule || next.scheduleId !== schedule)) break;
    batch.push(next);
  }
  return batch;
}

/**
 * One agent's runner. The server keeps the agent's queue; this hands each
 * undone item to the live session for its place, stores the answer, posts it
 * to the item's return address and forgets it once the server has it. Rooms,
 * direct messages and corners all go through the same path.
 */
export class AgentRunner {
  private readonly places = new Map<string, Place>();
  private readonly resetIds = new Map<string, string>();
  /** Items with an answer on disk or on the wire; never handed to the agent again. */
  private readonly answered = new Set<string>();
  /** Server-confirmed tool replies can finish an item before the harness ends. */
  private readonly completed = new Set<string>();
  private readonly answers: AnswerStore;
  private readonly stored = new Map<string, StoredAnswer>();
  private readonly posting = new Set<StoredAnswer>();
  private readonly durable = new Set<StoredAnswer>();
  private readonly restored: Promise<StoredAnswer[]>;
  private answersLoaded = false;
  private readonly releaseLiveOpen: () => void;
  private readonly connectionUsage = new ConnectorUsageRecorder();
  private readonly storage: PlaceStorage;
  private readonly agent: ReturnType<typeof runtimeIdentity>;
  private readonly grantRunner: GrantCommandRunner;
  private readonly grantRunnerServer: GrantRunnerServer;
  private grantEndpoint?: Promise<GrantRunnerEndpoint | undefined>;
  private endpoint?: GrantRunnerEndpoint;
  private latest: readonly AgentCommand[] = [];
  private stopped = false;
  private removalReads = 0;
  private wake?: () => void;
  private pendingBootstrap = true;
  /** The owner changed this agent's configuration while this helper ran. */
  private configurationChanged = false;

  constructor(
    private readonly runtime: AgentRuntimeRecord,
    private readonly configPath: string,
    private readonly baseConfig: BodyConfig,
    private readonly options: {
      daemonApi: DaemonApiClient;
      onConfigChanged?: () => void | Promise<void>;
    },
  ) {
    const runtimeDir = dirname(configPath);
    this.agent = runtimeIdentity(runtime.agent);
    this.answers = new AnswerStore(resolve(runtimeDir, 'answers'));
    this.restored = this.answers.all();
    this.grantRunner = new GrantCommandRunner({
      api: options.daemonApi,
      agentId: this.agent.publicKey,
    });
    this.grantRunnerServer = new GrantRunnerServer(
      this.grantRunner,
      (placeId, parentRoomId) =>
        prepareWorkspace({
          api: options.daemonApi,
          config: this.baseConfig,
          supervisorRoot: runtime.supervisorRoot,
          workspaceId: runtime.communityId,
          agent: this.agent,
          placeId,
          ...(parentRoomId ? { parentRoomId } : {}),
        }),
      async (placeId, input) => {
        if (input.action === 'operation')
          return options.daemonApi.execute(
            input.operation as keyof import('@beeline/api-contract/daemon').DaemonOperationMap,
            input.input as never,
            typeof input.commandId === 'string' ? input.commandId : undefined,
          );
        const session = this.places.get(placeId)?.session;
        if (!session) throw new Error('This place has no live session');
        if (input.action === 'command') {
          const item = session.command(typeof input.requestId === 'string' ? input.requestId : undefined);
          return item ? {
            roomId: item.roomId, requestId: item.turnRequestId, taskId: item.rootCommandId, itemId: item.id,
            promptSectionIds: session.promptSectionIds,
          } : null;
        }
        if (input.action === 'context') {
          if (input.prepare === true) await session.resources.prepare();
          return session.resources.read();
        }
        if (!session.current) throw new Error('Registry MCP requires the current request');
        return session.resources.mcp(input, {
          roomId: session.current.roomId,
          requestId: session.current.turnRequestId,
        });
      },
      (placeId, contextPath) => {
        const session = this.places.get(placeId)?.session;
        return session !== undefined && contextPath === encodeURIComponent(session.contextPath);
      },
    );
    this.storage = new PlaceStorage({
      supervisorRoot: runtime.supervisorRoot,
      runtimeDir,
      workspaceId: runtime.communityId,
      agentId: this.agent.publicKey,
      api: options.daemonApi,
      live: (placeId) => this.places.get(placeId)?.session.alive === true,
    });
    options.daemonApi.setQueueListener((commands, completed, stopped, resets) =>
      this.queueChanged(commands, completed, stopped, resets),
    );
    options.daemonApi.setConfigChangedListener(() => this.configChanged());
    options.daemonApi.setRoomsChangedListener(() => {
      this.pendingBootstrap = true;
      this.wake?.();
    });
    options.daemonApi.setCornerCompleteListener((cornerId) => void this.cornerComplete(cornerId));
    this.releaseLiveOpen = options.daemonApi.onLiveOpen(() => {
      // Registration interrupts the old connection's turn projections, while
      // these harnesses keep working. Reassert only their started invocations,
      // including one whose start reply the reconnect dropped.
      for (const place of this.places.values())
        if (place.turnStarted) this.recordTurnStart(place.turnStarted, place.resetId);
    });
  }

  private placeConfig(placeId: string): BodyConfig {
    const runtimeDir = dirname(this.configPath);
    const workspaceRoot =
      this.runtime.rooms.find((room) => room.channelId === placeId)?.root ??
      resolve(runtimeDir, 'rooms', placeId);
    return {
      ...this.baseConfig,
      workspaceRoot,
      agentSharedAssetRoot: workspaceAssetRoot(
        this.runtime.supervisorRoot,
        this.runtime.communityId,
      ),
      agentPrivateRoot: resolve(workspaceRoot, 'agent-private'),
      agentMemoryRoot: resolve(runtimeDir, 'memory'),
      openRouterRoutingCacheDir: openRouterRoutingCacheDir(runtimeDir),
      turnTraceDir: turnTraceDirectory(runtimeDir),
      agentHomeRoot: resolve(workspaceRoot, 'agent-home'),
    };
  }

  private place(item: AgentCommand): Place {
    const place = this.places.get(item.roomId);
    if (place) return place;
    const placeId = item.roomId;
    const resetId = this.resetIds.get(placeId);
    const created: Place = {
      waiting: [],
      resetId,
      session: new PlaceSession({
        agent: this.agent,
        runtime: this.runtime,
        config: this.placeConfig(placeId),
        api: this.options.daemonApi,
        grantRunnerFile: resolve(dirname(this.configPath), 'session-tools.json'),
        placeId,
        resetId,
        ...(item.parentRoomId ? { parentRoomId: item.parentRoomId } : {}),
        workspaceId: this.runtime.communityId,
        ...(this.endpoint ? { grantRunner: this.endpoint } : {}),
        onExit: () => this.sessionExited(placeId, created),
        cancelGrantedCommands: () => this.grantRunner.cancel(placeId),
      }),
    };
    // A place first seen after a configuration change would otherwise start
    // from its cached settings, which predate that change.
    if (this.configurationChanged) created.session.configurationChanged();
    this.places.set(placeId, created);
    this.grantRunner.register(placeId, created.session.grantPlace());
    return created;
  }

  /** The server's whole list of this agent's undone items, oldest first. */
  private queueChanged(
    commands: readonly AgentCommand[],
    completed: readonly string[] = [],
    stopped: readonly string[] = [],
    resets: readonly AgentPlaceReset[] = [],
  ): void {
    for (const { roomId, id } of resets)
      if (this.resetIds.get(roomId) !== id) {
        this.resetIds.set(roomId, id);
        const place = this.places.get(roomId);
        if (place) {
          clearTimeout(place.idleTimer);
          this.places.delete(roomId);
          this.grantRunner.unregister(roomId);
          place.session.retire();
        }
      }
    for (const id of completed) this.completed.add(id);
    // A person stopped a run after its reply: the item is already done, so
    // queue absence cannot carry the Stop. Its closing receipt still follows.
    for (const place of this.places.values())
      if (place.running && stopped.includes(place.running.id)) place.session.cancel();
    // An older serving image may still include a pending restart control.
    this.latest = commands.filter((item) => item.action !== 'restart');
    void this.restored
      .then((answers) => {
        if (!this.answersLoaded) this.restoreAnswers(answers);
        this.reconcileQueue();
      })
      .catch((error) => console.error('[body] queue delivery failed:', error));
  }

  private restoreAnswers(answers: readonly StoredAnswer[]): void {
    this.answersLoaded = true;
    for (const saved of answers) {
      if (!this.isCurrentAnswer(saved)) {
        this.removeAnswer(saved);
        continue;
      }
      // Retire generated notices left in an older helper's durable outbox.
      const retiredNotice = saved.text.startsWith(`${this.agent.name} stopped while answering this: `);
      const answer = retiredNotice ? { ...saved, text: '', harnessEnded: true, steps: undefined } : saved;
      this.stored.set(answer.itemId, answer);
      if (!retiredNotice) this.durable.add(answer);
      for (const id of [answer.itemId, ...(answer.queuedRequestIds ?? [])]) this.answered.add(id);
    }
  }

  private reconcileQueue(): void {
    const commands = this.latest;
    const listed = new Set(commands.map((item) => item.id));
    for (const answer of this.stored.values())
      if (!this.isCurrentAnswer(answer)) {
        this.stored.delete(answer.itemId);
        this.durable.delete(answer);
        for (const id of [answer.itemId, ...(answer.queuedRequestIds ?? [])]) this.answered.delete(id);
        if (!this.posting.has(answer)) this.removeAnswer(answer);
      }
    for (const item of commands)
      if (!this.answered.has(item.id)) this.place(item).session.resources.receiveCommand(item);
    const running = new Set([...this.places.values()].map((place) => place.running?.id));
    for (const id of this.completed) if (!running.has(id)) this.completed.delete(id);
    for (const id of this.answered)
      if (!listed.has(id) && !this.stored.has(id)) this.answered.delete(id);
    void this.resendStoredAnswers(listed);
    for (const place of this.places.values()) {
      // A reply tool completes the queue item while its harness is still
      // running. Only disappearance without a committed answer means Stop.
      if (
        place.running &&
        !listed.has(place.running.id) &&
        !this.answered.has(place.running.id) &&
        !this.completed.has(place.running.id)
      )
        place.session.cancel();
      place.waiting = place.waiting.filter((item) => listed.has(item.id));
    }
    const known = (item: AgentCommand) =>
      this.answered.has(item.id) ||
      [...this.places.values()].some(
        (place) =>
          place.running?.id === item.id || place.waiting.some((waiting) => waiting.id === item.id),
      );
    for (const item of commands.filter((item) => !known(item))) {
      const place = this.place(item);
      place.waiting.push(item);
    }
    for (const placeId of this.places.keys()) void this.pump(placeId);
  }

  /** Replay answers for visible items and finals from runs whose replies already committed. */
  private async resendStoredAnswers(listed: ReadonlySet<string>): Promise<void> {
    for (const answer of this.stored.values()) {
      if (
        (answer.finishesAnsweredItem ||
          [answer.itemId, ...(answer.queuedRequestIds ?? [])].some((id) => listed.has(id))) &&
        !this.posting.has(answer)
      ) {
        void this.post(answer);
      }
    }
  }

  /** Hand the next waiting item of one place to its session; one at a time per place. */
  private async pump(placeId: string): Promise<void> {
    const place = this.places.get(placeId);
    const item = place && !place.running && !this.stopped ? place.waiting.shift() : undefined;
    if (place && !place.running) this.armIdle(place, Boolean(item));
    if (place && item) await this.deliver(placeId, place, item);
  }

  private async deliver(placeId: string, place: Place, item: AgentCommand): Promise<void> {
    place.running = item;
    // Input arriving during a prompt belongs to the next prompt. Steering
    // acceptance does not prove the running answer covered that new request.
    const batch = turnBatch(item, place.waiting);
    const batched = new Set(batch.map((next) => next.id));
    const { retirement } = place.session;
    let started = false;
    const invocation = { id: randomUUID(), requestId: item.turnRequestId };
    try {
      await place.session.start(item);
      retirement.throwIfAborted();
      place.turnStarted = item;
      await this.options.daemonApi.execute('startAgentTurn', {
        roomId: item.roomId,
        requestId: item.turnRequestId,
        invocationId: invocation.id,
        resetId: place.resetId ?? null,
        ...(batch.length > 1 ? {batchedCommandIds:batch.slice(1).map(command=>command.id)} : {}),
      });
      retirement.throwIfAborted();
      started = true;
      const answer = await place.session.deliver(item, batch, invocation);
      retirement.throwIfAborted();
      place.turnStarted = undefined;
      // Empty background work closes quietly; an unanswered request stays owed.
      const steps = answer.text && answer.steps.length ? { steps: answer.steps } : {};
      const pendingBatch = batch.filter((next) =>
        this.latest.some((listed) => listed.id === next.id),
      );
      if (pendingBatch.length || this.completed.has(item.id))
        await this.store({
          itemId: (pendingBatch[0] ?? item).id,
          roomId: item.roomId,
          requestId: (pendingBatch[0] ?? item).turnRequestId,
          invocation,
          resetId: place.resetId,
          ...(!pendingBatch.length ? { finishesAnsweredItem: true } : {}),
          queuedRequestIds: pendingBatch.slice(1).map((next) => next.id),
          text: answer.text,
          harnessEnded: true,
          ...steps,
        });
      retirement.throwIfAborted();
      place.waiting = place.waiting.filter((next) => !batched.has(next.id));
      void Promise.resolve()
        .then(() => { if (!retirement.aborted) this.afterAnswer(item, answer, invocation); })
        .catch((error) => console.warn('[body] answer diagnostics failed:', error));
    } catch (error) {
      // A reset can commit before its snapshot arrives. The server has
      // already fenced this attempt, and the snapshot will redeliver its work.
      if (!retirement.aborted && !isCancelledTurn(error)) {
        console.error(`[body] place ${placeId} could not answer ${item.id}:`, error);
        if (
          started &&
          this.completed.has(item.id) &&
          !this.stopped &&
          !batch.some((next) => this.latest.some((listed) => listed.id === next.id))
        )
          await this.store({
            itemId: item.id,
            roomId: item.roomId,
            requestId: item.turnRequestId,
            text: '',
            harnessEnded: true,
            finishesAnsweredItem: true,
            resetId: place.resetId,
            invocation,
          });
        if (
          !retirement.aborted && batch.some(
            (next) =>
              this.latest.some((listed) => listed.id === next.id) && !this.answered.has(next.id),
          )
        ) {
          if (!this.stopped && !this.baseConfig.agentEnv?.BEELINE_FREE_AGENT_MODEL_TOKEN) this.reportOwnerBlocker(item, error);
          if (started && !this.stopped) {
            const pending = batch.filter((next) =>
              this.latest.some((listed) => listed.id === next.id),
            );
            if (pending.length)
              await this.store({
                itemId: pending[0]!.id,
                roomId: item.roomId,
                requestId: pending[0]!.turnRequestId,
                queuedRequestIds: pending.slice(1).map((next) => next.id),
                text: '',
                harnessEnded: true,
                resetId: place.resetId,
                invocation,
                failureReason: redactToolDetail(distillTurnFailureReason(error).text).slice(0, 2_000),
              });
          } else if (
            !this.stopped &&
            this.baseConfig.agentEnv?.BEELINE_FREE_AGENT_MODEL_TOKEN
          ) {
            try {
              await this.options.daemonApi.execute('startAgentTurn', {
                roomId: item.roomId,
                requestId: item.turnRequestId,
                resetId: place.resetId ?? null,
                available: false,
                failureReason: redactToolDetail(distillTurnFailureReason(error).text).slice(0, 2_000),
              });
              if (!retirement.aborted) {
                this.answered.add(item.id);
                started = true;
              }
            } catch (refusal) {
              if (!isCancelledTurn(refusal)) throw refusal;
            }
          } else {
            place.waiting.unshift(item);
            if (!this.stopped)
              void this.options.daemonApi
                .execute('startAgentTurn', {
                  roomId: item.roomId,
                  requestId: item.turnRequestId,
                  resetId: place.resetId ?? null,
                  available: false,
                })
                .catch((error) => console.warn('[body] offline status not written:', error));
          }
        }
        if (!retirement.aborted) {
          if (started) place.waiting = place.waiting.filter((next) => !batched.has(next.id));
          await place.session
            .stop()
            .catch((stopError) => console.warn('[body] session stop failed:', stopError));
        }
      }
    } finally {
      place.running = undefined;
      place.turnStarted = undefined;
    }
    if (started && !retirement.aborted) void this.pump(placeId);
  }

  private recordTurnStart(item: AgentCommand, resetId?: string): void {
    void this.options.daemonApi
      .execute('startAgentTurn', { roomId: item.roomId, requestId: item.turnRequestId, resetId: resetId ?? null })
      .catch((error) => console.warn('[body] delivery status not written:', error));
  }

  /** A harness that needs its owner (a sign-in, a spent allowance) names it on
   * the failed receipt; the server shows it once in the Room. */
  private reportOwnerBlocker(item: AgentCommand, error: unknown): void {
    const { text, kind } = distillTurnFailureReason(error);
    if (kind !== 'not-signed-in' && kind !== 'allowance-spent') return;
    void this.options.daemonApi
      .execute('postAgentTurnReceipt', {
        agentId: this.agent.publicKey,
        roomId: item.roomId,
        requestId: item.turnRequestId,
        outcome: 'failed',
        reason: redactToolDetail(text).slice(0, 2_000),
        reasonKind: kind,
      })
      .catch((receiptError) =>
        console.warn('[body] failed turn receipt not written:', receiptError),
      );
  }

  /** Usage and diagnostics follow the answer and never hold it. */
  private afterAnswer(item: AgentCommand, answer: Answer, invocation: AgentInvocation): void {
    void answer.cleanup().catch((error) => console.warn('[body] answer cleanup failed:', error));
    captureConnectionUsage(
      this.connectionUsage,
      {
        requestId: item.turnRequestId,
        agentId: this.agent.publicKey,
        ...(item.parentRoomId ? { cornerId: item.roomId } : { roomId: item.roomId }),
      },
      answer.toolCalls,
    );
    void this.connectionUsage
      .flush(this.options.daemonApi, item.turnRequestId)
      .catch((error) => console.warn('[body] usage diagnostics failed:', error));
    const trace = new TurnTrace({
      surface: item.parentRoomId ? 'corner' : 'room',
      agentId: this.agent.publicKey,
      roomId: item.roomId,
      requestId: item.turnRequestId,
    });
    trace.toolCalls([...answer.toolCalls]);
    const replay = trace.replay();
    void this.options.daemonApi
      .execute('postAgentTurnReceipt', {
        agentId: this.agent.publicKey,
        roomId: item.roomId,
        requestId: item.turnRequestId,
        outcome: answer.text ? 'answered' : 'silent',
        invocation,
        toolCalls: answer.toolCalls.length,
        ...mergeHarnessTurnMetrics(undefined, answer.tokenUsage),
        ...(replay ? { trace: replay } : {}),
      })
      .catch((error) => console.warn('[body] turn diagnostics not written:', error));
  }

  private async store(answer: StoredAnswer): Promise<void> {
    for (const id of [answer.itemId, ...(answer.queuedRequestIds ?? [])]) this.answered.add(id);
    this.stored.set(answer.itemId, answer);
    this.posting.add(answer);
    try {
      await this.answers.save(answer);
      if (this.isCurrentAnswer(answer)) {
        this.durable.add(answer);
        void this.post(answer);
      } else {
        this.removeAnswer(answer);
        this.posting.delete(answer);
      }
    } catch (error) {
      this.posting.delete(answer);
      console.error('[body] answer could not be saved:', error);
    }
  }

  private isCurrentAnswer(answer: StoredAnswer): boolean {
    return this.resetIds.get(answer.roomId) === answer.resetId;
  }

  private removeAnswer(answer: StoredAnswer): void {
    void this.answers.remove(answer).catch((error) => console.warn('[body] answer cleanup failed:', error));
  }

  /** Post a stored answer; the item is done on the server only once this lands. */
  private async post(answer: StoredAnswer): Promise<void> {
    const api = this.options.daemonApi;
    this.posting.add(answer);
    try {
      if (!this.durable.has(answer)) {
        await this.answers.save(answer);
        if (this.isCurrentAnswer(answer)) this.durable.add(answer);
      }
      if (this.isCurrentAnswer(answer)) {
        const receipt = await api.execute('postRoomMessage', {
          roomId: answer.roomId,
          requestId: answer.itemId,
          text: answer.text,
          presentation: 'message',
          ...(answer.harnessEnded ? { harnessEnded: true } : {}),
          ...(answer.invocation ? { invocation: answer.invocation } : {}),
          ...(answer.queuedRequestIds?.length ? { queuedRequestIds: answer.queuedRequestIds } : {}),
          ...(answer.steps ? { steps: answer.steps } : {}),
        });
        if (this.isCurrentAnswer(answer)) {
          if (receipt.answered !== false) {
            this.stored.delete(answer.itemId);
            this.durable.delete(answer);
            this.removeAnswer(answer);
          } else if (
            !answer.text &&
            this.latest.some(
              (item) =>
                [answer.itemId, ...(answer.queuedRequestIds ?? [])].includes(item.id) &&
                !isBackgroundCommand(item.reason),
            )
          ) {
            const pending = this.latest.filter((item) =>
              [answer.itemId, ...(answer.queuedRequestIds ?? [])].includes(item.id),
            );
            const hosted =
              answer.harnessEnded &&
              (this.baseConfig.agentEnv?.BEELINE_FREE_AGENT_ID ||
                this.baseConfig.agentEnv?.BEELINE_FREE_AGENT_MODEL_TOKEN);
            if (hosted)
              for (const item of pending)
                await api.execute('startAgentTurn', {
                  roomId: item.roomId,
                  requestId: item.turnRequestId,
                  resetId: answer.resetId ?? null,
                  available: false,
                  failureReason: answer.failureReason ?? 'Agent harness ended without a public answer',
                });
            // Hosted turns close visibly; personal helpers retain the owed request
            // for their next queue delivery after the server refused an empty answer.
            await this.answers.remove(answer);
            if (this.isCurrentAnswer(answer)) {
              this.stored.delete(answer.itemId);
              this.durable.delete(answer);
              if (!hosted)
                for (const id of [answer.itemId, ...(answer.queuedRequestIds ?? [])])
                  this.answered.delete(id);
            }
          }
        }
      }
    } catch (error) {
      // A queued item still owns its stored answer, including after a refusal.
      // Only a queue snapshot confirming completion or Stop can discard it.
      console.warn(`[body] answer for ${answer.itemId} not delivered yet:`, error);
    } finally {
      this.posting.delete(answer);
      if (!this.isCurrentAnswer(answer)) {
        this.durable.delete(answer);
        this.removeAnswer(answer);
      }
    }
  }

  private sessionExited(placeId: string, place: Place): void {
    if (this.places.get(placeId) !== place || this.stopped) return;
    // deliver() stores closing output; the server retains unanswered requests.
    if (!place.running) void place.session.stop().then(() => this.pump(placeId));
  }

  /** One stay-warm countdown per idle session; new work cancels it. */
  private armIdle(place: Place, busy: boolean): void {
    clearTimeout(place.idleTimer);
    if (busy || !place.session.alive) return;
    place.idleTimer = setTimeout(() => {
      if (!place.running && !place.waiting.length) void place.session.stop();
    }, SESSION_IDLE_MS);
    place.idleTimer.unref?.();
  }

  private configChanged(): void {
    this.configurationChanged = true;
    for (const [placeId, place] of this.places) {
      place.session.configurationChanged();
      if (!place.running) void place.session.stop().then(() => this.pump(placeId));
    }
    void Promise.resolve(this.options.onConfigChanged?.()).catch((error) =>
      console.error('[body] config-change refresh failed', error),
    );
  }

  private async cornerComplete(cornerId: string): Promise<void> {
    const place = this.places.get(cornerId);
    if (place && !place.running && !place.waiting.length) {
      await place.session.stop();
      if (this.places.get(cornerId) === place) this.places.delete(cornerId);
    }
    await this.storage
      .reapCorner(cornerId)
      .catch((error) => console.warn(`[body] thread ${cornerId} cleanup deferred:`, error));
  }

  /** The `workspace` tool's loopback door, shared with run_granted_command. */
  grantRunnerEndpoint(): Promise<GrantRunnerEndpoint | undefined> {
    return (this.grantEndpoint ??= this.grantRunnerServer.start().catch((error) => {
      console.error('[body] grant runner unavailable:', error);
      return undefined;
    }));
  }

  /** Membership and storage facts; never part of delivery. */
  private async bootstrap(): Promise<'member' | 'not-member' | 'unknown'> {
    const bootstrap = await this.options.daemonApi.execute('getDaemonBootstrap', {
      agentId: this.agent.publicKey,
    });
    publishStorageFacts(this.runtime.supervisorRoot, bootstrap.storageRooms ?? []);
    if (!bootstrap.workspaceIds.includes(this.runtime.communityId)) {
      this.removalReads += 1;
      return this.removalReads < 2 ? 'unknown' : 'not-member';
    }
    this.removalReads = 0;
    this.storage.sweep(bootstrap.storageRooms ?? []);
    return 'member';
  }

  async run(
    opts: {
      signal?: AbortSignal;
      onEstablished?: () => void | Promise<void>;
      onProgress?: (status: string, fault?: unknown) => void | Promise<void>;
    } = {},
  ): Promise<'aborted' | 'agent-removed'> {
    void this.grantRunnerEndpoint()
      .then(async (endpoint) => {
        this.endpoint = endpoint;
        if (endpoint)
          await writePrivateFileAtomically(
            resolve(dirname(this.configPath), 'session-tools.json'),
            JSON.stringify(endpoint),
          );
      })
      .catch((error) => console.warn('[body] session tools unavailable:', error));
    this.options.daemonApi.subscribeQueue();
    let established = false;
    try {
      while (!opts.signal?.aborted) {
        if (this.pendingBootstrap) {
          this.pendingBootstrap = false;
          try {
            const membership = await this.bootstrap();
            if (membership === 'not-member') return 'agent-removed';
            if (membership === 'unknown') this.pendingBootstrap = true;
            if (!established) {
              established = true;
              await opts.onEstablished?.();
            }
            await opts.onProgress?.('');
          } catch (error) {
            if (isAgentRemovedError(error)) return 'agent-removed';
            await opts.onProgress?.(
              `degraded: ${error instanceof Error ? error.message : String(error)}`,
              error,
            );
          }
        }
        if (opts.signal?.aborted) break;
        // Park until a wake (registered before the bootstrap recheck) or the
        // stop's abort; an abort ends the park and the loop sees the signal.
        await answer<void>('agent runner wake', opts.signal ? [opts.signal] : [], ({ resolve }) => {
          this.wake = () => resolve();
          if (this.pendingBootstrap) resolve();
        }).catch(() => undefined);
        this.wake = undefined;
      }
      return 'aborted';
    } finally {
      this.stopped = true;
      this.releaseLiveOpen();
      for (const place of this.places.values()) clearTimeout(place.idleTimer);
      await Promise.all(
        [...this.places.values()].map((place) => place.session.dispose().catch(() => undefined)),
      );
      await this.grantRunnerServer.close();
    }
  }
}
