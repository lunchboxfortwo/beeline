/** Durable outcome only. No model transcript, provider key or replayed answer. */
export type OwnedModelAttemptReceipt = Readonly<{
  requestId: string;
  state: 'unknown' | 'succeeded' | 'refused';
  evidence?: Readonly<{ kind: 'usage'; tokens: number; usd: number }> |
    Readonly<{ kind: 'not-dispatched'; reason: 'authority' | 'queue' | 'cancelled' | 'deadline' }> |
    Readonly<{ kind: 'provider-refused'; status: number }>;
}>;
