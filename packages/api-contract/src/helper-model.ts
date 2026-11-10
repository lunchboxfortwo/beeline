/** Issued only by a successful negotiated command/source claim. This bearer is
 * private authentication material; never prompt, journal or diagnostic input. */
export type OwnedModelCredential = Readonly<{
  v: 1;
  token: string;
  /** Legacy wire field. New credentials end with invocation authority, without an execution deadline. */
  expiresAt: number | null;
}>;

/** Durable outcome only. No model transcript, provider key or replayed answer. */
export type OwnedModelAttemptReceipt = Readonly<{
  requestId: string;
  state: 'unknown' | 'succeeded' | 'refused';
  evidence?: Readonly<{ kind: 'usage'; tokens: number; usd: number }> |
    Readonly<{ kind: 'not-dispatched'; reason: 'authority' | 'queue' | 'cancelled' | 'deadline' }> |
    Readonly<{ kind: 'provider-refused'; status: number }>;
}>;
