/** Existing machine registration owns these controls. No public admission pass
 * is sent. Owned-row interpretation is a server protocol rollback floor even
 * with admission disabled; it is independent of native runtime 40. */
export type HelperTurnOwnershipSource = {
  readonly connectionId: string;
  readonly epoch: number;
};

/** A reclaimed workflow reply remains fenced, but publication retries once so
 * a transient handoff cannot silently consume the final answer. Other authority
 * refusals (membership, cancellation, unknown generation) are not retryable. */
export const RECLAIMED_REPLY_REFUSAL = {
  status: 409,
  message: 'command output authority rejected: workflow generation ended',
} as const;
