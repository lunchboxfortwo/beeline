/** The only kinds of refusal on the request -> agent -> answer path. */
export const WALL_KINDS = ['signed-in', 'membership', 'credentials', 'sandbox', 'stop'] as const;
export type WallKind = typeof WALL_KINDS[number];

type WallReason = string | Error | Readonly<{ message: string; status?: number; cause?: Error }>;

export class WallRefusal extends Error {
  readonly status: number;
  readonly payload: Readonly<{ error: string }>;

  constructor(readonly kind: WallKind, reason: WallReason) {
    super(typeof reason === 'string' ? reason : reason.message, reason instanceof Error ? { cause: reason } : typeof reason === 'object' && reason.cause ? { cause: reason.cause } : undefined);
    this.name = 'WallRefusal';
    // A failed check is still an outage, not a denial. Propagation preserves
    // existing response status without moving any authority check here.
    const status = typeof reason === 'string' ? undefined : (reason as { status?: number }).status;
    this.status = status ?? (reason instanceof Error ? 503 : kind === 'signed-in' ? 401 : 403);
    this.payload = { error: this.message };
  }
}

/** Construct a refusal where its check lives; preserve an existing wall's kind. */
export function wall(kind: WallKind, reason: WallReason): WallRefusal {
  return reason instanceof WallRefusal ? reason : new WallRefusal(kind, reason);
}
