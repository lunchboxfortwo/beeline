/** Issued atomically with a hosted agent queue item. This bearer is
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

export function isOwnedModelCredential(value: unknown): value is OwnedModelCredential {
  if (!value || typeof value !== 'object') return false;
  const credential = value as Record<string, unknown>;
  return credential.v === 1 && typeof credential.token === 'string' &&
    /^bfmc_v1\.[a-f0-9]{32}\.[a-f0-9]{64}$/.test(credential.token) &&
    (credential.expiresAt === null || typeof credential.expiresAt === 'number' &&
      Number.isSafeInteger(credential.expiresAt) && credential.expiresAt > 0);
}
