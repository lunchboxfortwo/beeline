import { describe, expect, it } from 'vitest';
import type { ChatDisplayMessage } from './room-view-presentation';
import { SYSTEM_IDENTITY_PUBKEY } from './system-identity';
import { foldPillRuns, isGitHubEventRun, isPillMessage, isSystemLine, stopNotice } from './transcript-pills';
import { foldPrLifecycleRuns } from './pr-lifecycle';
import { ledgerSpeakerKey } from './ledger-attribution';
import { transcriptBylineOpeners } from './message-dates';

const row = (id: string, fields: Partial<ChatDisplayMessage> = {}): ChatDisplayMessage => ({
  id, text: id, isUser: false, timestamp: 1_800_000_000, ...fields,
});
const system = (id: string) => row(id, { isSystemNotice: true });
const AGENTS = new Set(['alan', 'jimmy']);

describe('transcript pills', () => {
  const say = (id: string, from = 'alan', to = 'jimmy') => row(id, {
    pubkey: from, agentCommand: { kind: 'message', recipient: { id: to, name: to, kind: 'agent' }, text: id } });

  it('pills agent orders, plain notices and Beeline-account rows', () => {
    expect(isPillMessage(system('s'))).toBe(true);
    expect(isSystemLine(system('s'))).toBe(true);
    expect(isPillMessage(row('b', { pubkey: SYSTEM_IDENTITY_PUBKEY }))).toBe(true);
    expect(isSystemLine(row('b', { pubkey: SYSTEM_IDENTITY_PUBKEY }))).toBe(true);
    // A Beeline-authored order takes the system notice path.
    expect(isPillMessage(say('beeline-order', SYSTEM_IDENTITY_PUBKEY))).toBe(true);
    expect(isPillMessage(row('o', {
      pubkey: 'alan', agentCommand: { kind: 'order', recipient: { id: 'jimmy', name: 'Jimmy', kind: 'agent' }, text: 'Go' },
    }))).toBe(true);
    expect(isPillMessage(row('m', { pubkey: 'dan' }))).toBe(false);
    expect(isSystemLine(row('m', { pubkey: 'dan' }))).toBe(false);
  });

  it('keeps a plain system notice in its own pill between agent runs', () => {
    const offline = row('host', { isSystemNotice: true, text: '@grunt joined',
      systemEvent: { subject: { kind: 'agent', id: 'grunt', name: 'Grunt' }, verb: 'joined' } });
    const rows = foldPillRuns([say('m1'), say('m2'), offline, say('m3')]);
    expect(rows.map(message => message.id)).toEqual(['m1', 'host', 'm3']);
    expect(rows[0]!.pillRun?.map(message => message.id)).toEqual(['m1', 'm2']);
    expect(rows[1]!.pillRun).toBeUndefined();
    expect(isPillMessage(rows[1]!)).toBe(true);
    // A lone agent message stays a single row with no folded run.
    expect(rows[2]!.pillRun).toBeUndefined();
  });

  it.each(['human', undefined] as const)('UAR-1 keeps %s recipients readable and breaks pill runs', (kind) => {
    const report = row('report', { isSystemNotice: true, pubkey: 'alan', isAgentAuthor: true,
      mentionPubkeys: ['jimmy'],
      agentCommand: { kind: 'report', recipient: { id: 'person', name: 'Person', kind }, text: 'Please choose the scope' } });
    expect(isPillMessage(report)).toBe(false);
    const rows = foldPillRuns([say('before1'), say('before2'), report, say('after1'), say('after2')]);
    expect(rows.map(message => message.id)).toEqual(['before1', 'report', 'after1']);
    expect(rows[0]!.foldedReadBoundaries?.map(boundary => boundary.id)).toEqual(['before1', 'before2']);
    expect(rows[1]!.pillRun).toBeUndefined();
    expect(rows[2]!.foldedReadBoundaries?.map(boundary => boundary.id)).toEqual(['after1', 'after2']);
  });

  it('pills provider cards while ordinary attachments and archive banners keep their own rows', () => {
    expect(isPillMessage(row('c', { ...say('c'), githubEvent: {} as never }))).toBe(true);
    expect(isPillMessage(row('a', { ...say('a'), attachments: [{} as never] }))).toBe(false);
    expect(isPillMessage(row('x', { ...say('x'), isArchivedNotice: true }))).toBe(false);
  });

  it('draws a folded PR or thread lifecycle run as a system pill', () => {
    const run = { items: [], subline: '' } as never;
    expect(isPillMessage(row('l', { githubEvent: {} as never, notificationLifecycleRun: run }))).toBe(true);
    expect(isPillMessage(row('d', { deleted: true, notificationLifecycleRun: run }))).toBe(true);
  });

  it('keeps a plain tag of another agent a message, and draws message() to an agent as a pill', () => {
    const tag = row('tag', { text: '@jimmy please review', pubkey: 'alan', isAgentAuthor: true, mentionPubkeys: ['jimmy'] });
    expect(isPillMessage(tag)).toBe(false);
    const rows = foldPillRuns([say('before'), tag, say('after')]);
    expect(rows.map(message => message.id)).toEqual(['before', 'tag', 'after']);
    expect(rows[1]!.pillRun).toBeUndefined();
    const sent = row('sent', { pubkey: 'alan', agentCommand: { kind: 'message', recipient: { id: 'jimmy', name: 'Jimmy', kind: 'agent' }, text: 'Please review' } });
    expect(isPillMessage(sent)).toBe(true);
  });

  it('folds consecutive pills into one row that keeps every folded id', () => {
    const rows = foldPillRuns([say('s1'), say('s2'), row('m1', { pubkey: 'dan' }), say('s3')]);
    expect(rows.map((message) => message.id)).toEqual(['s1', 'm1', 's3']);
    expect(rows[0]!.pillRun?.map((message) => message.id)).toEqual(['s1', 's2']);
    expect(rows[0]!.foldedIds).toEqual(['s1', 's2']);
    expect(rows[0]!.foldedReadBoundaries?.map((boundary) => boundary.id)).toEqual(['s1', 's2']);
    expect(rows[2]!.pillRun).toBeUndefined();
  });

  const merged = (id: string, number: number) => row(id, { isSystemNotice: true, text: `Merged ${number}`,
    systemEvent: { subject: { kind: 'github', name: 'GitHub' }, verb: 'merged pull request',
      object: { text: `Change ${number}`, url: `https://github.com/o/r/pull/${number}` } } });
  const paid = (id: string) => row(id, { walletTx: { direction: 'out', amountText: '$1', counterparty: 'x', chain: 'base',
    balanceAfterUsd: '$9', txUrl: 'https://example.com/tx' } as never });
  const fold = (messages: ChatDisplayMessage[]) => foldPillRuns(foldPrLifecycleRuns(messages));
  const runIds = (rows: ChatDisplayMessage[]) => rows.map(message => [message.id, message.pillRun?.map(entry => entry.id) ?? null]);

  it('folds GitHub events with the agent messages around them into one pill run that keeps every id', () => {
    // Events between messages: one run, with no lifecycle row left between the pills.
    const between = fold([say('m1'), merged('e1', 1), merged('e2', 2), say('m2')]);
    expect(runIds(between)).toEqual([['m1', ['m1', 'e1', 'm2']]]);
    expect(between[0]!.foldedIds).toEqual(['m1', 'e1', 'e2', 'm2']);
    expect(between[0]!.foldedReadBoundaries?.map(boundary => boundary.id)).toEqual(['m1', 'e1', 'e2', 'm2']);
    expect(between[0]!.pillRun![1]!.notificationLifecycleRun?.items.map(item => item.id)).toEqual(['e1', 'e2']);
    // Events first, and events last.
    expect(runIds(fold([merged('e1', 1), say('m1'), say('m2')]))).toEqual([['e1', ['e1', 'm1', 'm2']]]);
    expect(runIds(fold([say('m1'), merged('e1', 1)]))).toEqual([['m1', ['m1', 'e1']]]);
    // Events only: one lifecycle row, drawn as a pill.
    const only = fold([merged('e1', 1), merged('e2', 2)]);
    expect(runIds(only)).toEqual([['e1', null]]);
    expect(isPillMessage(only[0]!)).toBe(true);
    expect(isGitHubEventRun(only[0]!)).toBe(true);
    // A system line still ends the run.
    expect(runIds(fold([say('m1'), merged('e1', 1), system('joined'), say('m2')])))
      .toEqual([['m1', ['m1', 'e1']], ['joined', null], ['m2', null]]);
  });

  it('keeps payment runs as their own rows, apart from GitHub events and agent pills', () => {
    const rows = fold([say('m1'), merged('e1', 1), paid('p1'), merged('e2', 2), say('m2')]);
    expect(runIds(rows)).toEqual([['m1', ['m1', 'e1']], ['p1', null], ['e2', ['e2', 'm2']]]);
    expect(rows[1]!.notificationLifecycleRun?.items.map(item => item.kind)).toEqual(['payment']);
    expect(isGitHubEventRun(rows[1]!)).toBe(false);
  });

  it('opens a new sender group after a pill', () => {
    expect(ledgerSpeakerKey(row('o', {
      pubkey: 'alan', isAgentAuthor: true,
      agentCommand: { kind: 'order', recipient: { id: 'jimmy', name: 'Jimmy', kind: 'agent' }, text: 'Go' },
    }), AGENTS)).toBeNull();
    expect(ledgerSpeakerKey(row('tag', { pubkey: 'alan', isAgentAuthor: true, mentionPubkeys: ['jimmy'] }), AGENTS)).toBe('agent:alan');
    expect(ledgerSpeakerKey(row('reply', { pubkey: 'alan', isAgentAuthor: true }), AGENTS)).toBe('agent:alan');
    expect(transcriptBylineOpeners([system('s1'), row('m', { pubkey: 'dan' })])).toEqual(new Set(['m']));
    // A Beeline-account row is a system line, not a voice, though it is no longer a pill.
    expect(ledgerSpeakerKey(row('b', { pubkey: SYSTEM_IDENTITY_PUBKEY }), AGENTS)).toBeNull();
    expect(transcriptBylineOpeners([row('b', { pubkey: SYSTEM_IDENTITY_PUBKEY }), row('m', { pubkey: 'dan' })])).toEqual(new Set(['m']));
  });

  const stop = (id: string, kind: 'person' | 'agent') => row(id, { isSystemNotice: true, pubkey: 'x',
    systemEvent: { kind: 'turn-cancelled', subject: { kind, id: 'x', name: 'X' }, verb: 'stopped',
      object: { text: 'Jimmy', id: 'jimmy' }, consequence: 'turn cancelled' } });
  it('keeps a stop a pill, folded with agent messages around it', () => {
    expect(isPillMessage(stop('s', 'agent'))).toBe(true);
    expect(foldPillRuns([say('m1'), stop('s', 'agent'), say('m2')]).map(message => message.pillRun?.map(entry => entry.id)))
      .toEqual([['m1', 's', 'm2']]);
  });
  it('reads who stopped whom from a turn-cancelled line', () => {
    expect(stopNotice(stop('s', 'person'))).toEqual({
      stopper: { id: 'x', name: 'X', kind: 'human' }, stopped: { id: 'jimmy', name: 'Jimmy' } });
    expect(stopNotice(system('joined'))).toBeUndefined();
  });
});
