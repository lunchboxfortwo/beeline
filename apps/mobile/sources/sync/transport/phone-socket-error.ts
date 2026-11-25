/** A server refusal keeps its human reason and retryability through the socket. */
export class PhoneSocketError extends Error {
  readonly status: number;
  constructor(readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'PhoneSocketError';
    this.status = code === 'unauthorized' ? 401
      : code === 'access_denied' ? 403
      : code === 'not_found' || code === 'unknown_phone_operation' ? 404
      : code === 'conflict' ? 409
      : code === 'query_too_broad' ? 422
      : code === 'busy' || code === 'too_many_requests' || code === 'voice-daily-limit' ? 429
      : code === 'invalid_args' || code === 'invalid_request' || code.startsWith('invalid_') ? 400
      : retryable ? 503 : 400;
  }
}

export class PhoneSocketDisconnectedError extends Error {
  readonly socketRequest = true;
  constructor() {
    super('The connection closed before the server answered. The result is unknown.');
    this.name = 'PhoneSocketDisconnectedError';
  }
}

/** Socket disconnects and local deadlines carry this marker through Room reads. */
export function isPhoneSocketTransportError(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'socketRequest' in error && error.socketRequest === true;
}
