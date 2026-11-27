import type { ActivityFile, ActivityResultBlock, RoomViewActivity } from '@beeline/api-contract/phone';

const CREDENTIAL_IDENTITY_PATTERN =
  /fetch_credential|read_credential|raw_credential|[._]netrc\b|\.pgpass\b|\.git-credentials\b|\.npmrc\b|\.pypirc\b|\.docker[\\/]+config\.json\b|\.aws[\\/]+credentials\b|\.env|(?:(?<![a-z0-9_])credentials\b|credentials\.(?:json|ya?ml|toml|txt|ini|xml|env)|[\\/]+credentials\b)|\bid_[a-z0-9_]+\b|\.(?:pem|key)\b|private.?key/i;

const URI_SECRET_QUERY_PARAMS =
  /([?&](?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|auth|authorization|sig|signature|credential|session|session[_-]?id|cookie|jwt|bearer|key|x-amz-signature|x-amz-credential|x-amz-security-token)=)([^&#\s"'`<>]+)/gi;

const URI_USERINFO_SECRET =
  /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@"'`<>]+:)([^@\s"'`<>]+)(@)/gi;

const RECOGNIZED_DISPLAY_PREFIXES = [
  /(?:file:\/\/)?\/(?:home|Users)\/[^/\s"'`]+\/\.local\/state\/beeline\/agents\/[0-9a-f]+\/rooms\/[0-9a-f-]+\/agent-home\/(?:codex|claude|pi|user)\//gi,
  /(?:file:\/\/)?\/(?:home|Users)\/[^/\s"'`]+\/\.local\/state\/beeline\/corners\/[0-9a-f]+\//gi,
  /(?:file:\/\/)?\/(?:home|Users)\/[^/\s"'`]+\/\.local\/state\/beeline\/worktrees\/[^/\s"'`]+\//gi,
  /(?:file:\/\/)?(?:\/(?:home|Users)\/[^/\s"'`]+\/\.local\/state\/beeline\/[^/\s"'`]+\/)?agent-home\/(?:codex|claude|pi|user)\//gi,
] as const;

export function stripRecognizedDisplayPrefix(value: string): string {
  let current = value;
  for (const pattern of RECOGNIZED_DISPLAY_PREFIXES) {
    current = current.replace(pattern, '');
  }
  return current;
}

export function redactServerSecretText(value: string): { text: string; changed: boolean } {
  const next = value
    .replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g, '[REDACTED]')
    .replace(URI_USERINFO_SECRET, '$1[REDACTED]$3')
    .replace(URI_SECRET_QUERY_PARAMS, '$1[REDACTED]')
    .replace(/\b(Bearer\s+)[^\s,"'}\]]+/gi, '$1[REDACTED]')
    .replace(
      /(?<![?&])(["']?)\b(api[_-]?key|token|secret|password|passwd|authorization|credential|cookie|private[_-]?key)\1\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\]]+)/gi,
      '"$2": "[REDACTED]"',
    )
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/gi, '[REDACTED]')
    .replace(/\b(?:bat|brt|bdt|bde|bfm)_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, '[REDACTED]')
    .replace(/\bbfmc_v1\.[a-f0-9]{32}\.[a-f0-9]{64}\b/gi, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
  return { text: next, changed: next !== value };
}

function sanitizeDisplayLabel(value: string): string {
  return stripRecognizedDisplayPrefix(redactServerSecretText(value).text);
}

function sanitizeBlock(
  block: ActivityResultBlock,
  tracker: { sanitized: boolean },
): ActivityResultBlock {
  if (block.kind === 'text') {
    const res = redactServerSecretText(block.text);
    if (res.changed) tracker.sanitized = true;
    return { ...block, text: res.text };
  }
  if (block.kind === 'json') {
    const res = redactServerSecretText(block.text);
    if (res.changed) tracker.sanitized = true;
    return { ...block, text: res.text };
  }
  if (block.kind === 'diff') {
    // Strip recognized prefix on display path only; never rewrite patch hunks except secret redaction.
    const path = sanitizeDisplayLabel(block.path);
    const diffRes = redactServerSecretText(block.diff);
    if (diffRes.changed) tracker.sanitized = true;
    return { ...block, path, diff: diffRes.text };
  }
  if (block.kind === 'media') {
    return {
      ...block,
      ...(block.label ? { label: sanitizeDisplayLabel(block.label) } : {}),
    };
  }
  if (block.kind === 'resource') {
    const uriRes = block.uri ? redactServerSecretText(block.uri) : undefined;
    const textRes = block.text ? redactServerSecretText(block.text) : undefined;
    if (uriRes?.changed || textRes?.changed) tracker.sanitized = true;
    return {
      ...block,
      ...(uriRes ? { uri: uriRes.text } : {}),
      ...(block.name ? { name: sanitizeDisplayLabel(block.name) } : {}),
      ...(textRes ? { text: textRes.text } : {}),
    };
  }
  if (block.kind === 'unknown') {
    const textRes = block.text ? redactServerSecretText(block.text) : undefined;
    if (textRes?.changed) tracker.sanitized = true;
    return {
      ...block,
      ...(textRes ? { text: textRes.text } : {}),
    };
  }
  return block;
}

function sanitizeFile(file: ActivityFile, tracker: { sanitized: boolean }): ActivityFile {
  const path = sanitizeDisplayLabel(file.path);
  const diffRes = typeof file.diff === 'string' ? redactServerSecretText(file.diff) : undefined;
  if (diffRes?.changed) tracker.sanitized = true;
  return {
    ...file,
    path,
    ...(diffRes ? { diff: diffRes.text } : {}),
  };
}

function isSecretActivityItem(item: Record<string, unknown>): boolean {
  if (item.outputHidden === true) return true;
  if (item.output === 'Output hidden: contains a secret.') return true;
  const parts = [
    typeof item.title === 'string' ? item.title : '',
    typeof item.command === 'string' ? item.command : '',
    typeof item.input === 'string' ? item.input : '',
    Array.isArray(item.files)
      ? item.files
          .map((f) => (f && typeof f === 'object' && typeof (f as Record<string, unknown>).path === 'string' ? (f as Record<string, unknown>).path : ''))
          .join(' ')
      : '',
  ];
  return CREDENTIAL_IDENTITY_PATTERN.test(parts.join(' '));
}

/**
 * Sanitize both new and historical stored activity items before sending them
 * to any client (list, full, or room snapshot). Masking runs ahead of all
 * fallbacks; display prefixes are stripped only from display labels while
 * command operands and patch hunks stay faithful (with secret redaction only).
 */
export function sanitizeActivityItem(
  raw: unknown,
  options: { full: boolean },
): RoomViewActivity | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.kind !== 'string' || typeof item.title !== 'string') return null;

  if (item.kind !== 'tool') {
    const title = sanitizeDisplayLabel(item.title);
    const text = typeof item.text === 'string' ? redactServerSecretText(item.text).text : undefined;
    return {
      ...(item as RoomViewActivity),
      title,
      ...(text !== undefined ? { text } : {}),
    };
  }

  const title = sanitizeDisplayLabel(item.title);
  // 1. Secret masking runs ahead of all fallbacks.
  if (isSecretActivityItem(item)) {
    const out: Record<string, unknown> = {
      kind: 'tool',
      title,
      ...(typeof item.operation === 'string' ? { operation: item.operation } : {}),
      ...(typeof item.status === 'string' ? { status: item.status } : {}),
      outputHidden: true,
      ...(options.full ? { output: 'Output hidden: contains a secret.' } : {}),
      ...(typeof item.hasDetail === 'boolean' ? { hasDetail: item.hasDetail } : {}),
      ...(item.toolOutput && typeof item.toolOutput === 'object' ? { toolOutput: item.toolOutput } : {}),
      ...(item.toolGroup && typeof item.toolGroup === 'object' ? { toolGroup: item.toolGroup } : {}),
      ...(item.origin && typeof item.origin === 'object' ? { origin: item.origin } : {}),
    };
    return out as RoomViewActivity;
  }

  const tracker = { sanitized: item.sanitized === true };
  const summary = typeof item.summary === 'string' ? sanitizeDisplayLabel(item.summary) : undefined;
  const command =
    typeof item.command === 'string' ? redactServerSecretText(item.command).text : undefined;
  const input =
    typeof item.input === 'string' ? redactServerSecretText(item.input).text : undefined;
  const outputRes =
    typeof item.output === 'string' ? redactServerSecretText(item.output) : undefined;
  if (outputRes?.changed) tracker.sanitized = true;
  const textRes =
    typeof item.text === 'string' ? redactServerSecretText(item.text) : undefined;
  if (textRes?.changed) tracker.sanitized = true;

  const files = Array.isArray(item.files)
    ? item.files
        .filter((f): f is ActivityFile => Boolean(f && typeof f === 'object' && typeof (f as Record<string, unknown>).path === 'string'))
        .map((f) => sanitizeFile(f, tracker))
    : undefined;

  const blocks = Array.isArray(item.blocks)
    ? item.blocks
        .filter((b): b is ActivityResultBlock => Boolean(b && typeof b === 'object' && typeof (b as Record<string, unknown>).kind === 'string'))
        .map((b) => sanitizeBlock(b, tracker))
    : undefined;

  let plan = item.plan as RoomViewActivity['plan'] | undefined;
  if (plan && typeof plan === 'object' && Array.isArray(plan.items)) {
    plan = {
      ...(typeof plan.objective === 'string'
        ? { objective: sanitizeDisplayLabel(plan.objective) }
        : {}),
      items: plan.items.map((entry) => ({
        ...entry,
        step: redactServerSecretText(entry.step).text,
      })),
    };
  }

  return {
    ...(item as RoomViewActivity),
    title,
    ...(summary !== undefined ? { summary } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(outputRes !== undefined ? { output: outputRes.text } : {}),
    ...(textRes !== undefined ? { text: textRes.text } : {}),
    ...(files !== undefined ? { files } : {}),
    ...(blocks !== undefined ? { blocks } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(tracker.sanitized ? { sanitized: true } : {}),
  };
}

export function sanitizeActivityList(
  raw: unknown,
  options: { full: boolean } = { full: true },
): RoomViewActivity[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: RoomViewActivity[] = [];
  for (const item of raw) {
    const sanitized = sanitizeActivityItem(item, options);
    if (sanitized) out.push(sanitized);
  }
  return out;
}
