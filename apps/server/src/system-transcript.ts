import type { SystemEvent, SystemTranscript } from '@beeline/api-contract/phone';
import { SCHEDULE_SCHEDULER_ID } from '@beeline/api-contract/scheduled-prompts';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { HIDDEN_WAKE_CARD_TYPES } from './room-choice.js';

export function systemTranscript(
  authorId: string,
  presentation: string,
  cardType?: string | null,
  event?: SystemEvent | null,
  durableFact?: string | null,
): SystemTranscript {
  const origin = event?.subject.kind === 'github' || cardType?.startsWith('github-') ? 'github'
    : authorId === SCHEDULE_SCHEDULER_ID ? 'scheduler' : 'system';
  const hidden = HIDDEN_WAKE_CARD_TYPES.some(type => type === cardType) ||
    event?.kind === 'schedule-ran' || event?.kind === 'computer-session-activity' ||
    (presentation === 'activity' && !durableFact);
  return { origin, visibility: hidden ? 'hidden' : presentation === 'card' ? 'card' : 'notice' };
}

/** Compatibility for rows written before system provenance was stored. */
export function projectSystemTranscript(row: {
  author_id: string;
  presentation: string;
  card_type: string | null;
  system_event: SystemEvent | null;
  durable_fact?: string | null;
  deleted_at?: Date | null;
  system_transcript?: SystemTranscript | null;
}): SystemTranscript | undefined {
  if (row.deleted_at) return { origin: 'system', visibility: 'notice' };
  if (row.system_transcript) return row.system_transcript;
  if (row.system_event || row.presentation === 'system' || row.durable_fact ||
      row.author_id === SYSTEM_IDENTITY_ID || row.author_id === SCHEDULE_SCHEDULER_ID ||
      row.card_type?.startsWith('github-') || row.card_type === 'daemon-fact') {
    return systemTranscript(row.author_id, row.presentation, row.card_type, row.system_event, row.durable_fact);
  }
  return undefined;
}
