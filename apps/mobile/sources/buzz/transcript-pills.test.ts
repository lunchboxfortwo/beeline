import { describe, expect, it } from 'vitest';
import type { ChatDisplayMessage } from './room-view-presentation';
import { SYSTEM_IDENTITY_PUBKEY } from './system-identity';
import { foldPillRuns, isAgentToAgentMessage, isPillMessage } from './transcript-pills';
import { ledgerSpeakerKey } from './ledger-attribution';
import { transcriptBylineOpeners } from './message-dates';

const row = (id: string, fields: Partial<ChatDisplayMessage> = {}): ChatDisplayMessage => ({
  id, text: id, isUser: false, timestamp: 1_800_000_000, ...fields,
});
const system = (id: string) => row(id, { isSystemNotice: true });
const AGENTS = new Set(['alan', 'jimmy']);

describe('transcript pills', () => {
  it('treats system lines, Beeline-account rows and agent orders as pills', () => {
    expect(isPillMessage(system('s'))).toBe(true);
    expect(isPillMessage(row('b', { pubkey: SYSTEM_IDENTITY_PUBKEY }))).toBe(true);
    expect(isPillMessage(row('o', {
      pubkey: 'alan', agentCommand: { kind: 'order', recipient: { id: 'jimmy', name: 'Jimmy' }, text: 'Go' },
    }))).toBe(true);
    expect(isPillMessage(row('m', { pubkey: 'dan' }))).toBe(false);
  });

  it('keeps cards and attachments out of pills', () => {
    expect(isPillMessage(row('c', { isSystemNotice: true, githubEvent: {} as never }))).toBe(false);
    expect(isPillMessage(row('a', { isSystemNotice: true, attachments: [{} as never] }))).toBe(false);
    expect(isPillMessage(row('x', { isSystemNotice: true, isArchivedNotice: true }))).toBe(false);
  });

  it('draws a folded PR or thread lifecycle run as a system pill', () => {
    const run = { items: [], subline: '' } as never;
    expect(isPillMessage(row('l', { githubEvent: {} as never, notificationLifecycleRun: run }))).toBe(true);
    expect(isPillMessage(row('d', { deleted: true, notificationLifecycleRun: run }))).toBe(false);
  });

  it('reads an agent message that mentions only agents as agent-to-agent', () => {
    const toJimmy = row('a2a', { pubkey: 'alan', isAgentAuthor: true, mentionPubkeys: ['jimmy'] });
    expect(isAgentToAgentMessage(toJimmy, AGENTS)).toBe(true);
    expect(isAgentToAgentMessage({ ...toJimmy, mentionPubkeys: ['jimmy', 'dan'] }, AGENTS)).toBe(false);
    expect(isAgentToAgentMessage({ ...toJimmy, mentionPubkeys: [] }, AGENTS)).toBe(false);
    expect(isAgentToAgentMessage(row('p', { pubkey: 'dan', mentionPubkeys: ['jimmy'] }), AGENTS)).toBe(false);
  });

  it('folds consecutive pills into one row that keeps every folded id', () => {
    const rows = foldPillRuns([system('s1'), system('s2'), row('m1', { pubkey: 'dan' }), system('s3')]);
    expect(rows.map((message) => message.id)).toEqual(['s1', 'm1', 's3']);
    expect(rows[0]!.pillRun?.map((message) => message.id)).toEqual(['s1', 's2']);
    expect(rows[0]!.foldedIds).toEqual(['s1', 's2']);
    expect(rows[0]!.foldedReadBoundaries?.map((boundary) => boundary.id)).toEqual(['s1', 's2']);
    expect(rows[2]!.pillRun).toBeUndefined();
  });

  it('keeps a lifecycle disclosure separate from adjacent avatar pills', () => {
    const lifecycle = row('merges', { isSystemNotice: true,
      notificationLifecycleRun: { items: [], subline: '' }, foldedIds: ['merge1', 'merge2'] });
    const rows = foldPillRuns([system('before'), lifecycle, system('after')]);
    expect(rows.map(message => message.id)).toEqual(['before', 'merges', 'after']);
    expect(rows[1]!.pillRun).toBeUndefined();
    expect(rows[1]!.foldedIds).toEqual(['merge1', 'merge2']);
  });

  it('opens a new sender group after a pill', () => {
    expect(ledgerSpeakerKey(row('o', {
      pubkey: 'alan', isAgentAuthor: true,
      agentCommand: { kind: 'order', recipient: { id: 'jimmy', name: 'Jimmy' }, text: 'Go' },
    }), AGENTS)).toBeNull();
    expect(ledgerSpeakerKey(row('a2a', { pubkey: 'alan', isAgentAuthor: true, mentionPubkeys: ['jimmy'] }), AGENTS)).toBeNull();
    expect(ledgerSpeakerKey(row('reply', { pubkey: 'alan', isAgentAuthor: true }), AGENTS)).toBe('agent:alan');
    expect(transcriptBylineOpeners([system('s1'), row('m', { pubkey: 'dan' })])).toEqual(new Set(['m']));
  });
});
