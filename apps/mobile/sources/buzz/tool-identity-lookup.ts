import type { ChannelReferenceIndex } from './channel-reference';

export type ToolIdentityParticipant = {
  readonly pubkey: string;
  readonly handle: string;
  readonly name?: string;
};

export type ToolIdentityLookup = {
  readonly participants?: readonly ToolIdentityParticipant[];
  readonly channelIndex?: ChannelReferenceIndex;
  readonly speakerName?: string;
};

const HEX64_EXACT = /^[0-9a-f]{64}$/i;
const UUID_EXACT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS_TOKEN =
  /\b([0-9a-f]{64})@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
const HEX64_TOKEN = /\b[0-9a-f]{64}\b/gi;
const UUID_TOKEN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const KNOWN_APP_NAMES: Readonly<Record<string, string>> = {
  'registry-mcp:squire': 'Trusty Squire',
  squire: 'Trusty Squire',
  'beeline:wallet': 'Wallet',
  'beeline:workflow': 'Workflow',
  'beeline:vault': 'Vault',
  'beeline:browser_share': 'Browser share',
  'beeline:avatar': 'Avatar',
  'beeline:onboarding': 'Onboarding',
};

export function isRawHex64(value: string): boolean {
  return HEX64_EXACT.test(value.trim());
}

export function isRawUuid(value: string): boolean {
  return UUID_EXACT.test(value.trim());
}

export function resolveMemberLabel(
  raw: string | undefined,
  lookup?: ToolIdentityLookup,
): string | undefined {
  if (!raw?.trim()) return undefined;
  const trimmed = raw.trim();
  const normalized = trimmed.toLowerCase();
  const hit = lookup?.participants?.find(
    (entry) =>
      entry.pubkey.toLowerCase() === normalized ||
      entry.handle.replace(/^@/, '').toLowerCase() === normalized.replace(/^@/, ''),
  );
  if (hit) {
    const handle = hit.handle.replace(/^@/, '').trim();
    if (handle) return `@${handle}`;
    if (hit.name?.trim()) return hit.name.trim();
  }
  if (isRawHex64(trimmed)) return undefined;
  return trimmed.startsWith('@') ? trimmed : trimmed;
}

export function resolveMemberDisplayName(
  raw: string | undefined,
  lookup?: ToolIdentityLookup,
): string | undefined {
  if (!raw?.trim()) return undefined;
  const trimmed = raw.trim();
  const normalized = trimmed.toLowerCase();
  const hit = lookup?.participants?.find(
    (entry) =>
      entry.pubkey.toLowerCase() === normalized ||
      entry.handle.replace(/^@/, '').toLowerCase() === normalized.replace(/^@/, ''),
  );
  if (hit) {
    if (hit.name?.trim()) return hit.name.trim();
    const handle = hit.handle.replace(/^@/, '').trim();
    if (handle) return handle.charAt(0).toUpperCase() + handle.slice(1);
  }
  if (isRawHex64(trimmed)) return undefined;
  return trimmed.replace(/^@/, '');
}

export function resolvePlaceLabel(
  raw: string | undefined,
  lookup?: ToolIdentityLookup,
): string | undefined {
  if (!raw?.trim()) return undefined;
  const trimmed = raw.trim();
  const normalized = trimmed.toLowerCase();
  const corner = lookup?.channelIndex?.corners.find(
    (entry) => entry.channelId.toLowerCase() === normalized,
  );
  if (corner?.name.trim()) return `#${corner.name.trim().replace(/^#/, '')}`;
  const room = lookup?.channelIndex?.rooms.find(
    (entry) => entry.channelId.toLowerCase() === normalized,
  );
  if (room?.name.trim()) return `#${room.name.trim().replace(/^#/, '')}`;
  if (isRawUuid(trimmed)) return undefined;
  return trimmed;
}

export function parseAgentAddress(
  raw: string | undefined,
  lookup?: ToolIdentityLookup,
): { agent?: string; agentDisplay?: string; place?: string; wasAddress: boolean } {
  if (!raw?.trim()) return { wasAddress: false };
  const trimmed = raw.trim();
  const at = trimmed.indexOf('@');
  if (at > 0 && at < trimmed.length - 1) {
    const left = trimmed.slice(0, at);
    const right = trimmed.slice(at + 1);
    const looksLikeAgentAtPlace =
      isRawHex64(left) || isRawUuid(right) || /^[\w.-]+@[\w.-]+$/.test(trimmed);
    if (looksLikeAgentAtPlace) {
      const agent = resolveMemberLabel(left, lookup);
      const agentDisplay = resolveMemberDisplayName(left, lookup);
      const place = resolvePlaceLabel(right, lookup);
      return { agent, agentDisplay, place, wasAddress: true };
    }
  }
  if (isRawHex64(trimmed)) {
    return {
      agent: resolveMemberLabel(trimmed, lookup),
      agentDisplay: resolveMemberDisplayName(trimmed, lookup),
      wasAddress: false,
    };
  }
  if (isRawUuid(trimmed)) {
    return { place: resolvePlaceLabel(trimmed, lookup), wasAddress: false };
  }
  return { agent: resolveMemberLabel(trimmed, lookup) ?? trimmed, wasAddress: false };
}

export function formatMessageTarget(
  target: string | undefined,
  room: string | undefined,
  lookup?: ToolIdentityLookup,
): { object: string; agent?: string; agentDisplay?: string; place?: string } {
  const parsed = parseAgentAddress(target, lookup);
  const place = parsed.place ?? resolvePlaceLabel(room, lookup);
  if (parsed.wasAddress) {
    const agent = parsed.agent ?? 'agent';
    return {
      object: place ? `message to ${agent} in ${place}` : `message to ${agent}`,
      agent,
      agentDisplay: parsed.agentDisplay,
      place,
    };
  }
  if (target && isRawHex64(target)) {
    const agent = parsed.agent ?? 'agent';
    return {
      object: place ? `message to ${agent} in ${place}` : `message to ${agent}`,
      agent,
      agentDisplay: parsed.agentDisplay,
      place,
    };
  }
  if (target && isRawUuid(target)) {
    return {
      object: place ? `message in ${place}` : 'message in thread',
      place: place ?? 'thread',
    };
  }
  if (parsed.agent) {
    return {
      object: place ? `message to ${parsed.agent} in ${place}` : `message to ${parsed.agent}`,
      agent: parsed.agent,
      agentDisplay: parsed.agentDisplay,
      place,
    };
  }
  if (place) {
    return { object: `message in ${place}`, place };
  }
  return { object: 'message' };
}

export function sanitizeIdsInText(text: string, lookup?: ToolIdentityLookup): string {
  return text
    .replace(ADDRESS_TOKEN, (_match, agentId: string, placeId: string) => {
      const agent = resolveMemberLabel(agentId, lookup) ?? 'agent';
      const place = resolvePlaceLabel(placeId, lookup);
      return place ? `${agent} in ${place}` : agent;
    })
    .replace(HEX64_TOKEN, (hex) => resolveMemberLabel(hex, lookup) ?? 'agent')
    .replace(UUID_TOKEN, (id) => resolvePlaceLabel(id, lookup) ?? 'thread');
}

export function humanizeAppName(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const trimmed = raw.trim();
  const known = KNOWN_APP_NAMES[trimmed.toLowerCase()];
  if (known) return known;
  const stripped = trimmed.replace(/^(?:registry-mcp|beeline):/i, '').replace(/[_-]+/g, ' ').trim();
  if (!stripped) return trimmed;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

export function formatSchedulePerson(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.handle === 'string' && rec.handle.trim()) {
    return `@${rec.handle.trim().replace(/^@/, '')}`;
  }
  if (typeof rec.name === 'string' && rec.name.trim()) return rec.name.trim();
  if (typeof rec.identityId === 'string' && rec.identityId.trim()) {
    return rec.identityId.trim().slice(0, 8);
  }
  return undefined;
}

export function formatShortNextRun(nextRunAt: unknown, cadence: unknown): string | undefined {
  if (typeof nextRunAt !== 'number' || !Number.isFinite(nextRunAt)) return undefined;
  const date = new Date(nextRunAt * 1_000);
  if (Number.isNaN(date.getTime())) return undefined;
  const timeZone =
    cadence &&
    typeof cadence === 'object' &&
    !Array.isArray(cadence) &&
    (cadence as Record<string, unknown>).kind === 'cron' &&
    typeof (cadence as Record<string, unknown>).timeZone === 'string' &&
    (cadence as Record<string, unknown>).timeZone
      ? String((cadence as Record<string, unknown>).timeZone)
      : 'UTC';
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
      timeZoneName: 'short',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function summarizeScheduleListOutput(
  outputObj: Record<string, unknown>,
): { object: string; receipt?: string } | undefined {
  if (!Array.isArray(outputObj.schedules)) return undefined;
  const entries = outputObj.schedules.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)),
  );
  if (!entries.length) return { object: 'schedules' };
  const first = entries[0]!;
  const title =
    (typeof first.title === 'string' && first.title.trim()) ||
    (typeof first.workflowName === 'string' && first.workflowName.trim()) ||
    (typeof first.scheduleId === 'string' && first.scheduleId.trim()) ||
    undefined;
  if (!title) return { object: 'schedules' };
  const details: string[] = [];
  const nextRun = formatShortNextRun(first.nextRunAt, first.cadence);
  if (nextRun) details.push(`next ${nextRun}`);
  const repliesTo = formatSchedulePerson(first.repliesTo);
  if (repliesTo) details.push(`replies to ${repliesTo}`);
  const summary = details.length ? `${title} (${details.join(' · ')})` : title;
  const more = entries.length > 1 ? ` +${entries.length - 1} more` : '';
  return {
    object: `schedules · ${summary}${more}`,
    receipt: `${summary}${more}`,
  };
}
