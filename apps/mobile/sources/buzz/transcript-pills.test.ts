import { describe, expect, it } from 'vitest';
import type { ChatDisplayMessage } from './room-view-presentation';
import { SYSTEM_IDENTITY_PUBKEY } from './system-identity';
import { foldPillRuns, isPillMessage } from './transcript-pills';
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
      pubkey: 'alan', agentCommand: { kind: 'order', recipient: { id: 'jimmy', name: 'Jimmy', kind: 'agent' }, text: 'Go' },
    }))).toBe(true);
    expect(isPillMessage(row('m', { pubkey: 'dan' }))).toBe(false);
  });

  it.each(['human', undefined] as const)('UAR-1 keeps %s recipients readable and breaks pill runs', (kind) => {
    const report = row('report', { isSystemNotice: true, pubkey: 'alan', isAgentAuthor: true,
      mentionPubkeys: ['jimmy'],
      agentCommand: { kind: 'report', recipient: { id: 'person', name: 'Person', kind }, text: 'Please choose the scope' } });
    expect(isPillMessage(report)).toBe(false);
    const rows = foldPillRuns([system('before1'), system('before2'), report, system('after1'), system('after2')]);
    expect(rows.map(message => message.id)).toEqual(['before1', 'report', 'after1']);
    expect(rows[0]!.foldedReadBoundaries?.map(boundary => boundary.id)).toEqual(['before1', 'before2']);
    expect(rows[1]!.pillRun).toBeUndefined();
    expect(rows[2]!.foldedReadBoundaries?.map(boundary => boundary.id)).toEqual(['after1', 'after2']);
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

  it('keeps a plain tag of another agent a message, and draws message() to an agent as a pill', () => {
    const tag = row('tag', { pubkey: 'alan', isAgentAuthor: true });
    expect(isPillMessage(tag)).toBe(false);
    const sent = row('sent', { pubkey: 'alan', agentCommand: { kind: 'message', recipient: { id: 'jimmy', name: 'Jimmy', kind: 'agent' }, text: 'Please review' } as never });
    expect(isPillMessage(sent)).toBe(true);
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
      agentCommand: { kind: 'order', recipient: { id: 'jimmy', name: 'Jimmy', kind: 'agent' }, text: 'Go' },
    }), AGENTS)).toBeNull();
    expect(ledgerSpeakerKey(row('tag', { pubkey: 'alan', isAgentAuthor: true, mentionPubkeys: ['jimmy'] }), AGENTS)).toBe('agent:alan');
    expect(ledgerSpeakerKey(row('reply', { pubkey: 'alan', isAgentAuthor: true }), AGENTS)).toBe('agent:alan');
    expect(transcriptBylineOpeners([system('s1'), row('m', { pubkey: 'dan' })])).toEqual(new Set(['m']));
  });
});
