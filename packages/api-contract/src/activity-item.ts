export type ActivityFile = {
  readonly path: string;
  readonly status?: string;
  readonly diff?: string;
  /** True when the diff text was truncated to stay within step byte budgets. */
  readonly diffTruncated?: boolean;
  /** Exact added line count, set only when the diff is complete and untruncated. */
  readonly addedLines?: number;
  /** Exact removed line count, set only when the diff is complete and untruncated. */
  readonly removedLines?: number;
  /** 1-based line number when reported by the adapter. */
  readonly line?: number;
  /** 1-based inclusive end line when explicitly reported by the adapter. */
  readonly endLine?: number;
};

export type ActivityResultBlock =
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly truncated?: boolean;
    }
  | {
      readonly kind: 'json';
      readonly text: string;
      readonly truncated?: boolean;
      readonly omittedCount?: number;
    }
  | {
      readonly kind: 'diff';
      readonly path: string;
      readonly status?: string;
      readonly diff: string;
      readonly truncated?: boolean;
    }
  | {
      readonly kind: 'media';
      readonly mediaKind: 'image' | 'audio';
      readonly mimeType?: string;
      readonly label?: string;
      readonly sizeBytes?: number;
      readonly available?: boolean;
    }
  | {
      readonly kind: 'resource';
      readonly mode: 'link' | 'text' | 'blob';
      readonly uri?: string;
      readonly name?: string;
      readonly mimeType?: string;
      readonly text?: string;
      readonly sizeBytes?: number;
      readonly truncated?: boolean;
    }
  | {
      readonly kind: 'unknown';
      readonly rawType?: string;
      readonly text?: string;
    };

export type ActivityOrigin = {
  readonly kind: 'subagent';
  readonly label?: string;
  readonly sessionId?: string;
};

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
  /** Concise human-readable description/summary supplied by the tool input. */
  readonly summary?: string;
  /** Observed process exit code when explicitly reported by the adapter. */
  readonly exitCode?: number;
  /** Observed termination signal (e.g. SIGKILL) when reported by the adapter. */
  readonly signal?: string;
  /** True when captured output or blocks were bounded/truncated before persistence. */
  readonly outputTruncated?: boolean;
  /** Count of omitted structured entries when bounded before persistence. */
  readonly omittedCount?: number;
  /** True when only a terminal handle was returned without captured output or exit status. */
  readonly terminalOnly?: boolean;
  /** True when output was suppressed because it matched secret/credential rules. */
  readonly outputHidden?: boolean;
  /** True when secret/credential redaction modified stored output text. */
  readonly sanitized?: boolean;
  /** Subagent origin when the call ran inside a delegated subagent session. */
  readonly origin?: ActivityOrigin;
  /** Bounded, redacted tool argument summaries for the corner ledger. */
  readonly command?: string;
  readonly input?: string;
  /** Bounded first/last-line excerpt of a completed tool result. */
  readonly output?: string;
  /** Bounded ordered sequence of ACP result blocks for mixed or structured results. */
  readonly blocks?: readonly ActivityResultBlock[];
  /** The identity whose message triggered the turn this row belongs to ("at Alex's request"). */
  readonly requestedBy?: { readonly pubkey: string; readonly name?: string };
  readonly files?: readonly ActivityFile[];
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
