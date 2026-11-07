/** Content-free provenance survives MCP and HTTP boundaries. */
export type SquireCause =
  'process-exit' | 'connection-lost' | 'needs-sign-in' | 'request-refused' | 'result-unknown';
export type SquireOutcome = {
  cause: SquireCause;
  operationId?: string;
  accepted: boolean | null;
  completed: boolean;
  reconnect?: 'in-progress' | 'failed';
};
export class SquireOperationError extends Error {
  constructor(
    message: string,
    readonly outcome: SquireOutcome,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SquireOperationError';
  }
}
export function squireOutcome(error: unknown): SquireOutcome {
  return error instanceof SquireOperationError
    ? error.outcome
    : { cause: 'result-unknown', accepted: null, completed: false };
}
