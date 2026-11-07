/** Keep transport diagnostics out of the text a person reads. */
export function appErrorCopy(reason: unknown, fallback = 'Could not complete request'): string {
  const record = reason && typeof reason === 'object' ? reason as Record<string, unknown> : undefined;
  const message = typeof reason === 'string' ? reason : typeof record?.message === 'string' ? record.message : '';
  const status = typeof record?.status === 'number' ? record.status : Number(message.match(/(?:\(|\bHTTP(?: status)?[ :]+)([45]\d{2})\b/)?.[1]);
  // Socket transport failures already have the one app-wide recovery banner.
  if (record?.socketRequest === true) return '';
  const clientFailure = status >= 400 && status < 500;
  if (status >= 500 || (!clientFailure && /network (?:request failed|unavailable)|failed to fetch|networkerror|connection closed before|timed? ?out|timeout|load failed|did not answer|\boffline\b/i.test(message + ' ' + (record?.name ?? '')))) return fallback;
  if (!clientFailure && /^(?:Type|Reference|Syntax|Range|URI|Eval)Error$/.test(String(record?.name ?? ''))) return fallback;
  // Some operation adapters carry human refusals in a plain Error, without HTTP metadata.
  const serverMessage = clientFailure && typeof record?.code === 'string' && !/^[\w.-]+$/.test(record.code) ? record.code : message;
  const human = serverMessage.replace(/^Monolith \w+ failed \(\d+\):\s*/, '').trim();
  if (!human || (record && !clientFailure && !/\s/.test(human))) return fallback;
  if (/\b\w*Error\b|(?:\bHTTP[ :]+[45]\d{2}|\([45]\d{2}\b)|\b[a-z]+(?:_[a-z]+)+\b/i.test(human)) return fallback;
  if (!clientFailure && /\b(?:TLS|WebRTC)\b|Cannot read propert|(?:request|read) failed/i.test(human)) return fallback;
  return human;
}

/** Read failures have one recovery owner. Only a server's human refusal is local UI. */
export function appReadErrorCopy(reason: unknown): string {
  const status = reason && typeof reason === 'object' && 'status' in reason ? Number(reason.status) : 0;
  if (status >= 400 && status < 500 && status !== 408) return appErrorCopy(reason, 'This request was refused.');
  // A few provider adapters reject locally before a request and carry their
  // ownership refusal as an Error rather than an HTTP status.
  const message = reason instanceof Error ? reason.message : '';
  return /another member|only (?:the )?owner|not (?:allowed|permitted)|permission denied|access denied/i.test(message)
    ? appErrorCopy(reason, '') : '';
}
