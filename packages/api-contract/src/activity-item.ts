export type ActivityItem = {
  readonly kind: 'thinking' | 'tool' | 'output' | 'summary' | 'note';
  readonly title: string;
  /**
   * Durable corner narration when `kind='output'`; an earlier assistant text
   * run shown inside the steps line when `kind='note'`. Never private thought
   * text.
   */
  readonly text?: string;
  readonly operation?: string;
  readonly status?: string;
  /** Bounded, redacted tool argument summaries for the corner ledger. */
  readonly command?: string;
  readonly input?: string;
  /** Bounded first/last-line excerpt of a completed tool result. */
  readonly output?: string;
  /** The identity whose message triggered the turn this row belongs to ("at Alex's request"). */
  readonly requestedBy?: { readonly pubkey: string; readonly name?: string };
  readonly files?: readonly {
    readonly path: string;
    readonly status?: string;
    readonly diff?: string;
  }[];
  /**
   * On a `note`: this text carries on the previous note. One text run longer
   * than a note may be is split across consecutive notes, never cut.
   */
  readonly continues?: boolean;
  readonly plan?: {
    readonly objective?: string;
    readonly items: readonly {
      readonly step: string;
      readonly status: 'pending' | 'in_progress' | 'completed';
    }[];
  };
};
