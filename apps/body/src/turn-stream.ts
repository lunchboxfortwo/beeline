import type { DaemonApiClient } from './daemon-api-client.js';
import { HelperOverlayOwner } from './helper-overlay.js';
import { sanitizeAgentReply } from './reply-sanitizer.js';

/** The provisional draft and durable reply share a turn identifier. */
export interface AgentTurnStreamOptions {
  api: DaemonApiClient;
  agentId: string;
  roomId: string;
  /**
   * The live draft's turn id, which MUST equal the durable reply's request id:
   * the phone suppresses a draft the moment a reply with the same id lands, so
   * any other id leaves a ghost draft duplicating the message.
   */
  requestId: string;
  /** The queue item this draft belongs to. */
  commandId: string;
  /** Log prefix naming the surface, e.g. `monolith Room <id>` or `corner <id>`. */
  label: string;
}

/** Sanitize the closing message selected by ACP for the durable reply. */
export function durableReplyText(agentText: string): string {
  return sanitizeAgentReply(agentText);
}

export class AgentTurnStream {
  /**
   * The newest snapshot not yet handed to a write. A draft is a picture of the
   * whole answer so far, so an older snapshot that never reached the wire is
   * not a lost message — it is a frame nobody needed. Keeping only the newest
   * one bounds the lane at ONE write in flight plus ONE waiting.
   */
  private pending: string | undefined;
  /** The draft write on the wire, if any. Never rejects; failures are logged. */
  private inFlight: Promise<void> | undefined;
  /** Closed lanes publish nothing more, so the answer never queues behind a draft. */
  private closed = false;
  /**
   * The retract this lane already sent. A settled turn that throws afterwards
   * reaches the same retract a second time, and one empty lane is the whole
   * point: asking twice would only be a second write saying what is already so.
   */
  private retraction: Promise<void> | undefined;

  private readonly overlay:HelperOverlayOwner|undefined;
  constructor(private readonly options: AgentTurnStreamOptions) {
    const transport=options.api.channel?.overlay;
    if(transport && (transport.enabled() || transport.selected?.())) {
      // Registration loss cannot restore the growing-snapshot producer while
      // this command is still bound to the negotiated overlay protocol.
      this.overlay=new HelperOverlayOwner({
        agentId:options.agentId,roomId:options.roomId,commandId:options.commandId,turnId:options.requestId,
        turnGeneration:options.commandId,kind:'draft'},transport);
    }
  }

  /** Replace the draft with the current ACP message. */
  readonly onChunk = (currentRun: string): void => {
    const text = sanitizeAgentReply(currentRun);
    if (!text || this.closed) return;
    this.pending = text;
    this.publishPending();
  };

  /**
   * Hand the newest snapshot to the wire, one write at a time.
   *
   * Serialized, never parallel: two drafts in flight can land out of order and
   * a reader would watch the answer go backwards. Serialized used to mean an
   * unbounded chain — every delta got its own write, and the durable reply
   * awaited the whole tail, so a finished answer sat behind writes showing text
   * nobody would ever read. It waits for at most one write now, and only to
   * keep the retract last.
   */
  private publishPending(): void {
    if (this.inFlight || this.pending === undefined) return;
    const text = this.pending;
    if(this.overlay){
      this.pending=undefined;
      try{this.overlay.update(text);}catch(error){
        console.error(`[thin-core] ${this.options.label} overlay parked:`,error);void this.overlay.close('retract');
      }
      return;
    }
    this.pending = undefined;
    const { api, agentId, roomId, requestId, label } = this.options;
    this.inFlight = api
      .execute('postAgentDraft', { agentId, roomId, turnId: requestId, text, latestChunk: text })
      .then(() => undefined)
      .catch((error) => console.error(`[thin-core] ${label} draft publish failed:`, error))
      .then(() => {
        this.inFlight = undefined;
        this.publishPending();
      });
  }

  /**
   * Stop drafting. The answer is known from here on, so anything still waiting
   * is obsolete and is dropped rather than published ahead of the final.
   */
  close(): void {
    this.closed = true;
    this.pending = undefined;
  }

  /**
   * Dissolve the draft, publishing nothing.
   *
   * Every ending uses this: the settle below calls it once the durable reply is
   * on the wire, and a turn that THROWS calls it directly. A throw never
   * reaches a settle, and `close()` alone only stops future writes — the last
   * snapshot stays live on the page, so a turn the Room has already reported
   * stopped or failed keeps a half-written answer visibly in progress under it.
   */
  async retract(): Promise<void> {
    this.close();
    this.retraction ??= (async () => {
      // A draft write already on the wire can land after this. The retract has
      // to be the last word on this lane, or that late write puts an obsolete
      // draft back after the lane was supposed to be empty.
      await this.inFlight;
      if(this.overlay){await this.overlay.close('retract');return;}
      const { api, agentId, roomId, requestId, label } = this.options;
      await api
        .execute('retractAgentLiveOutput', {
          agentId,
          roomId,
          turnId: requestId,
          kind: 'draft',
        })
        .catch((error) => console.error(`[thin-core] ${label} draft retract failed:`, error));
    })();
    await this.retraction;
  }
}
