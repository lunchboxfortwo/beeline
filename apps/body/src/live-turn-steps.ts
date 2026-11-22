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
      invocationId: string;
    },
  ) {}

  readonly onToolCalls = (calls: readonly ToolCallEntry[]): void => {
    calls.forEach((call, index) => {
      if (!call.resultReceived && !['completed', 'failed'].includes(call.status ?? '')) return;
      const key = call.id ?? `anonymous-${index}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      const activity = roomReplySteps([{ kind: 'tool', call }]);
      this.pending = this.pending
        .then(async () => {
          await this.api.execute('postAgentActivity', {
            agentId: this.turn.agentId,
            roomId: this.turn.roomId,
            requestId: this.turn.requestId,
            cornerActivityKey: `${this.turn.invocationId}:${index}`,
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
      return !this.saved.has(step.call.id ?? `anonymous-${index}`);
    });
  }
}
