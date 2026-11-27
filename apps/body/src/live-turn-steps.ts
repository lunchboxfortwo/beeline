import { createHash } from 'node:crypto';
import type { AgentInvocation } from '@beeline/api-contract/daemon';
import type { ToolCallEntry, AgentTurnStep } from './acp.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { roomReplySteps } from './room-turn-steps.js';

/** Completed tool rows use the existing activity ledger, serialized in completion order. */
export class LiveTurnSteps {
  private readonly seen = new Set<string>();
  private readonly saved = new Set<string>();
  private pending = Promise.resolve();
  constructor(
    private readonly api: DaemonApiClient,
    private readonly turn: {
      agentId: string;
      roomId: string;
      requestId: string;
      invocation?: AgentInvocation;
      current?: () => boolean;
    },
  ) {}

  private callKey(call: ToolCallEntry, index: number): string {
    const scope = call.origin?.sessionId ?? call.sessionId ?? '';
    const base = call.id ?? `anonymous-${index}`;
    return scope ? `${scope}\0${base}` : base;
  }

  readonly onToolCalls = (calls: readonly ToolCallEntry[]): void => {
    calls.forEach((call, index) => {
      if (
        !call.resultReceived &&
        !['completed', 'failed', 'error', 'cancelled', 'canceled', 'signalled', 'signaled'].includes(
          (call.status ?? '').toLowerCase(),
        )
      ) {
        return;
      }
      const key = this.callKey(call, index);
      if (this.seen.has(key)) return;
      this.seen.add(key);
      // ACP appends background tasks after ordinary calls; snapshot positions move.
      const activityKey = createHash('sha256').update(JSON.stringify([this.turn.invocation?.id ?? this.turn.requestId, key])).digest('hex');
      // A result may retain the earlier in-progress status until another update.
      const lowerStatus = (call.status ?? '').toLowerCase();
      const settledStatus =
        !lowerStatus || ['in_progress', 'in-progress', 'pending', 'running', 'started', 'working'].includes(lowerStatus)
          ? 'completed'
          : call.status!;
      const finished = { ...call, status: settledStatus };
      const activity = roomReplySteps([{ kind: 'tool', call: finished }]);
      this.pending = this.pending
        .then(async () => {
          if (this.turn.current?.() === false) return;
          await this.api.execute('postAgentActivity', {
            agentId: this.turn.agentId,
            roomId: this.turn.roomId,
            requestId: this.turn.requestId,
            ...(this.turn.invocation ? { invocation: this.turn.invocation } : {}),
            cornerActivityKey: activityKey,
            activity,
          });
          this.saved.add(key);
        })
        .catch((error) => console.warn('[body] live step write failed:', error));
    });
  };

  async remaining(steps: readonly AgentTurnStep[]): Promise<AgentTurnStep[]> {
    await this.pending;
    let toolIndex = 0;
    return steps.filter((step) => {
      if (step.kind !== 'tool') return true;
      const index = toolIndex++;
      return !this.saved.has(this.callKey(step.call, index));
    });
  }
}
