import React, { useLayoutEffect, useState } from 'react';
import { XStack, YStack, useThemeName } from 'tamagui';
import { ArrowRight, CircleCheck, CircleDot, CircleX, CornerDownRight, GitMerge, GitPullRequest, GitPullRequestClosed } from 'lucide-react-native';
import { Btn, Copy, Glyph, HEIGHT, T } from '@/ui/grammar';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { GitHubMark } from '@/components/buzz/GitHubMark';
import { TranscriptNavigationRow } from '@/components/buzz/IndexRow';
import { LedgerDisclosure } from '@/components/buzz/LedgerDisclosure';
import { TranscriptLine } from './TranscriptLine';
import { SYSTEM_IDENTITY_PUBKEY } from '@/buzz/system-identity';

const PILL_FACE_SIZE = 22;
/** The Beeline logo inside the system circle: 22 less the ring and a 3 px inset. */
const SYSTEM_MARK_SIZE = 14;
/** The solid stop square inside its ring: small enough to read as a stop button, not a checkbox. */
const STOP_SQUARE_SIZE = 8;
/** A folded run shows at most this many faces; opening it (and its label) shows everyone. */
const RUN_FACES = 3;
/** An opened group of events longer than this shows two and an "N more" row. */
const EVENT_GROUP_SHOWN = 3;

/** One end of a pill: the Beeline account, GitHub, a person or an agent. */
export type PillFace =
    | { kind: 'system'; name: string }
    | { kind: 'github'; name: string }
    | { kind: 'agent' | 'human'; seed: string; name: string; face?: string; avatarUrl?: string };

/** A GitHub PR, issue, commit or check event, or a Beeline thread event, as one pill or one opened row. */
export type PillEvent = {
    /** Who reports it: GitHub for PRs, issues, commits and checks; Beeline for threads, whether or not the Room has a repository. */
    source: 'github' | 'beeline';
    /** The mark a lone event pill shows beside its ring. */
    mark?: 'opened' | 'merged' | 'closed' | 'failed' | 'thread' | 'issueOpened' | 'issueClosed';
    /** "Merged". Empty when `text` says it all. */
    verb: string;
    /** The PR or issue number, in brass. */
    number?: string;
    /** The PR, issue, check or thread title. */
    title: string;
    /** A whole repository line (commits pushed, checks passed), when GitHub phrased it. */
    text?: string;
    /** The event's full meaning for a screen reader, e.g. "Merged PR #77 Delete the offline-host line". */
    spoken: string;
    /** Whether the event adds to a run's count; a repeated webhook line for one PR event does not. */
    counted: boolean;
    /** Opens the event's thread, or GitHub when it has none. */
    open?: { label: string; onPress: () => void };
};

/** One message of a folded agent run, read in send order once the run opens. */
export type PillRunEntry = {
    id: string;
    from: PillFace;
    to?: PillFace;
    time: string;
    /** A stop: drawn face, stop glyph, face, with no text. */
    stop?: boolean;
    /** A system message: it puts the ringed Beeline logo on the folded pill. */
    system?: boolean;
    /** A GitHub or Beeline event: `from` is that ring, and the row reads the event, not a message. */
    event?: PillEvent;
    body?: React.ReactNode;
};

export type PillItem = {
    id: string;
    from: PillFace;
    to?: PillFace;
    time: string;
    /** A stop of an agent's turn: face, stop glyph, face, with no text. */
    stop?: boolean;
    /** A lone event: its GitHub or Beeline ring and its state mark, with no text. */
    event?: PillEvent;
    /** Consecutive pill messages (agent-to-agent messages, stops and GitHub events) folded into one pill: faces and a count. */
    run?: readonly PillRunEntry[];
    /** The message, read under the row once its pill is opened. */
    body: React.ReactNode;
    system: boolean;
};

/** A face-sized ring: holds the Beeline logo for a system face and the stop square for a stop. */
function Ring({ children, testID }: { children: React.ReactNode; testID: string }) {
    return (
        <YStack width={PILL_FACE_SIZE} height={PILL_FACE_SIZE} borderRadius="full" borderWidth={1} borderColor="strongStroke"
            alignItems="center" justifyContent="center" testID={testID}>
            {children}
        </YStack>
    );
}

const EVENT_MARKS = {
    opened: GitPullRequest, merged: GitMerge, closed: GitPullRequestClosed, failed: CircleX, thread: CornerDownRight,
    issueOpened: CircleDot, issueClosed: CircleCheck,
} as const;

/**
 * A face whose plate would vanish on the pill fill gets a 1 px edge: in a dark
 * theme a picture or a person's ink plate is as dark as the pill. Agent
 * creatures sit on a mid-tone plate and need none.
 */
function edged(face: PillFace, dark: boolean): boolean {
    return dark && (face.kind === 'human' || (face.kind === 'agent' && Boolean(face.avatarUrl)));
}

function Face({ face }: { face: PillFace }) {
    const dark = useThemeName().startsWith('dark');
    if (face.kind === 'github') {
        return (
            <Ring testID="pill-github-face">
                <GitHubMark size={SYSTEM_MARK_SIZE} />
            </Ring>
        );
    }
    if (face.kind === 'system') {
        // The Beeline account reads as a bot face: its logo inside a ring, the size of every other face.
        return (
            <Ring testID="pill-system-face">
                <IdentityMark kind="human" seed={SYSTEM_IDENTITY_PUBKEY} name={face.name} size={SYSTEM_MARK_SIZE} />
            </Ring>
        );
    }
    const edge = edged(face, dark);
    // The edge sits inside the face's own box so every face keeps one size.
    const size = edge ? PILL_FACE_SIZE - 2 : PILL_FACE_SIZE;
    const mark = face.kind === 'agent'
        ? <IdentityMark kind="agent" seed={face.seed} face={face.face} avatarUrl={face.avatarUrl} name={face.name} size={size} />
        : <IdentityMark kind="human" seed={face.seed} face={face.face} avatarUrl={face.avatarUrl} name={face.name} size={size} />;
    if (!edge) return mark;
    return (
        <YStack width={PILL_FACE_SIZE} height={PILL_FACE_SIZE} borderRadius="sm" borderWidth={1} borderColor="strongStroke"
            overflow="hidden" alignItems="center" justifyContent="center" testID="pill-face-edge">
            {mark}
        </YStack>
    );
}

function heading(item: Pick<PillItem, 'from' | 'to'>): string {
    return item.to ? `${item.from.name} → ${item.to.name}` : item.from.name;
}

const GITHUB_KEY = 'github';

function faceKey(face: PillFace): string {
    return face.kind === 'system' ? SYSTEM_IDENTITY_PUBKEY : face.kind === 'github' ? GITHUB_KEY : face.seed;
}

/** Everyone in a run, in the order they first appear. */
function runFaces(run: readonly PillRunEntry[]): PillFace[] {
    const seen = new Map<string, PillFace>();
    for (const entry of run) {
        for (const face of entry.to ? [entry.from, entry.to] : [entry.from]) {
            if (!seen.has(faceKey(face))) seen.set(faceKey(face), face);
        }
    }
    return [...seen.values()];
}

export const BEELINE_FACE: PillFace = { kind: 'system', name: 'Beeline' };
export const GITHUB_FACE: PillFace = { kind: 'github', name: 'GitHub' };

/** A Beeline notice, a person's stop included; an agent's stop reads as part of the agents' talk. */
export function isNotice(entry: PillRunEntry): boolean {
    return Boolean(entry.system) && !(entry.stop && entry.from.kind === 'agent');
}

/** True when an entry's own heading draws the ringed Beeline face. */
function beelineHeaded(entry: PillRunEntry): boolean {
    return entry.from.kind === 'system' || entry.to?.kind === 'system';
}

/**
 * The faces a folded run shows, at most `RUN_FACES`, and only faces its opened
 * headings draw. Whoever stopped a turn leads, so a person's stop stays
 * visible while folded; the ringed Beeline logo leads only when an opened
 * entry is headed by it.
 */
function foldedFaces(item: PillItem): PillFace[] {
    const run = item.run ?? [];
    const notice = (entry: PillRunEntry) => item.system || isNotice(entry);
    // Events lead with their rings (GitHub, then Beeline), so a folded merge or thread opening still shows.
    const github = run.some((entry) => entry.event?.source === 'github') ? [GITHUB_FACE] : [];
    // The Beeline ring shows only when an opened heading draws it: a Beeline notice or a thread event, never a person's stop.
    const beeline = run.some(beelineHeaded) ? [BEELINE_FACE] : [];
    const stoppers = run.filter((entry) => entry.stop && notice(entry)).map((entry) => entry.from);
    const seen = new Set<string>();
    const lead = [...github, ...beeline];
    const ordered = [...lead, ...stoppers, ...runFaces(run)].filter((face) => {
        const key = faceKey(face);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    return ordered.slice(0, RUN_FACES);
}

function names(faces: readonly PillFace[]): string {
    const all = faces.map((face) => face.name);
    return all.length <= 1 ? all.join('') : `${all.slice(0, -1).join(', ')} and ${all.at(-1)}`;
}

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** A run's messages and its counted events, by who reports them. */
function runCounts(run: readonly PillRunEntry[]): { messages: number; github: number; beeline: number } {
    const counted = (source: PillEvent['source']) => run.filter((entry) => entry.event?.counted && entry.event.source === source).length;
    return { messages: run.filter((entry) => !entry.event).length, github: counted('github'), beeline: counted('beeline') };
}

const SOURCE_NAMES = { github: 'GitHub', beeline: 'Beeline' } as const;

/** The folded run's visible count: "5 messages · 13 events", dropping an absent kind. */
export function runCountLabel(run: readonly PillRunEntry[]): string {
    const { messages, github, beeline } = runCounts(run);
    const events = github + beeline;
    return [messages ? plural(messages, 'message') : '', events ? plural(events, 'event') : '']
        .filter(Boolean).join(' · ');
}

function pillLabel(item: PillItem, expanded: boolean): string {
    const verb = expanded ? 'Hide' : 'Read';
    if (item.event) return `${verb} ${SOURCE_NAMES[item.event.source]} event: ${item.event.spoken}, ${item.time}`;
    if (item.run?.some((entry) => entry.event)) {
        const { messages, github, beeline } = runCounts(item.run);
        const parts = [messages ? plural(messages, 'message') : '', github ? plural(github, 'GitHub event') : '',
            beeline ? plural(beeline, 'Beeline event') : ''].filter(Boolean);
        const spokenParts = parts.length > 2 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts.join(' and ');
        const between = names(runFaces(item.run).filter((face) => face.kind !== 'system' && face.kind !== 'github'));
        // Only messages Beeline itself sent count as from Beeline; thread events are counted above.
        const notices = item.run.filter((entry) => !entry.event && entry.from.kind === 'system').length;
        return `${verb} ${spokenParts}${between ? ` between ${between}` : ''}${notices ? `, ${notices} from Beeline` : ''}, ${item.time}`;
    }
    if (item.run && item.system) {
        const about = runFaces(item.run).filter((face) => face.kind !== 'system');
        return `${verb} ${item.run.length} system messages${about.length ? ` about ${names(about)}` : ''}, ${item.time}`;
    }
    if (item.run) {
        const between = names(runFaces(item.run).filter((face) => face.kind !== 'system'));
        // Only messages Beeline itself sent count as from Beeline; a person's stop is the person's.
        const notices = item.run.filter((entry) => entry.from.kind === 'system').length;
        return `${verb} ${item.run.length} messages between ${between}${notices ? `, ${notices} from Beeline` : ''}, ${item.time}`;
    }
    if (item.stop) return `${item.from.name} stopped ${item.to?.name ?? ''}`;
    return `${verb} message from ${heading(item)}, ${item.time}`;
}

/** Two faces joined by an arrow, or by the ringed stop glyph for a stop. */
function Pair({ from, to, stop }: { from: PillFace; to?: PillFace; stop?: boolean }) {
    return (
        <>
            <Face face={from} />
            {to ? (stop ? (
                <Ring testID="pill-stop-ring">
                    <YStack width={STOP_SQUARE_SIZE} height={STOP_SQUARE_SIZE} backgroundColor="secondary" testID="pill-stop-square" />
                </Ring>
            ) : <Glyph icon={ArrowRight} size={14} />) : null}
            {to ? <Face face={to} /> : null}
        </>
    );
}

const SOURCE_FACES = { github: GITHUB_FACE, beeline: BEELINE_FACE } as const;

/** The ring pair of a lone event pill: its GitHub or Beeline ring, then the event's state mark. */
function EventPair({ event }: { event: PillEvent }) {
    const Mark = event.mark ? EVENT_MARKS[event.mark] : undefined;
    return (
        <>
            <Face face={SOURCE_FACES[event.source]} />
            {Mark ? <Ring testID={`pill-event-mark-${event.mark}`}><Glyph icon={Mark} size={14} /></Ring> : null}
        </>
    );
}

/**
 * One opened event as a system line, the format an opened stop uses: meta at
 * the quiet ink, #number in brass, and a brass chevron when it opens.
 */
function EventLine({ id, event }: { id: string; event: PillEvent }) {
    const copy = (
        <T v="meta" color="secondary" numberOfLines={2} ellipsizeMode="tail" testID={`pill-event-text-${id}`}>
            {event.text ?? <>
                {event.verb ? `${event.verb} ` : null}
                {event.number ? <T v="meta" color="needsYou">{`#${event.number}`}</T> : null}
                {event.number ? ' ' : null}
                {event.title}
            </>}
        </T>
    );
    if (!event.open) {
        return <YStack minHeight={HEIGHT.control} justifyContent="center" testID={`pill-event-${id}`}
            accessible accessibilityLabel={event.spoken}>{copy}</YStack>;
    }
    return (
        <TranscriptNavigationRow testID={`pill-event-${id}`} singleDestination
            trailing={{ accessibilityLabel: `${event.spoken}. ${event.open.label}`, onPress: event.open.onPress, testID: `pill-event-open-${id}` }}>
            {copy}
        </TranscriptNavigationRow>
    );
}

/** Back-to-back events from one source under one "ring · time" heading; more than three show two and "N more". */
function EventGroup({ events, targetId }: { targetId?: string; events: readonly (PillRunEntry & { event: PillEvent })[] }) {
    const [all, setAll] = useState(false);
    const hiddenTarget = events.length > EVENT_GROUP_SHOWN && events.slice(2).some(entry => entry.id === targetId);
    useLayoutEffect(() => { if (hiddenTarget) setAll(true); }, [hiddenTarget]);
    const first = events[0]!;
    const source = SOURCE_NAMES[first.event.source];
    const shown = all || events.length <= EVENT_GROUP_SHOWN ? events : events.slice(0, 2);
    return (
        <YStack gap="1" minWidth={0} testID={`pill-event-group-${first.id}`}>
            <XStack gap="1" alignItems="center" accessibilityLabel={`${source}, ${first.time}`}>
                <Face face={SOURCE_FACES[first.event.source]} />
                <Copy small quiet>{`· ${first.time}`}</Copy>
            </XStack>
            <YStack minWidth={0}>
                {shown.map((entry) => <EventLine key={entry.id} id={entry.id} event={entry.event} />)}
                {shown.length < events.length ? (
                    <LedgerDisclosure expanded={false} accessibilityState={{ expanded: false }}
                        accessibilityLabel={`${events.length - shown.length} more ${source} events`} onPress={() => setAll(true)}
                        rowTestID={`pill-event-more-${first.id}`}>{`${events.length - shown.length} more`}</LedgerDisclosure>
                ) : null}
            </YStack>
        </YStack>
    );
}

type RunBlock =
    | { kind: 'message'; entry: PillRunEntry }
    | { kind: 'events'; events: (PillRunEntry & { event: PillEvent })[] };

/** Send order, with back-to-back events from one source gathered under one heading. */
function runBlocks(run: readonly PillRunEntry[]): RunBlock[] {
    const blocks: RunBlock[] = [];
    for (const entry of run) {
        const last = blocks.at(-1);
        if (entry.event) {
            const event = entry as PillRunEntry & { event: PillEvent };
            if (last?.kind === 'events' && last.events[0]!.event.source === event.event.source) last.events.push(event);
            else blocks.push({ kind: 'events', events: [event] });
        } else blocks.push({ kind: 'message', entry });
    }
    return blocks;
}

/** One opened message or stop under its face → face heading. */
function MessageEntry({ entry }: { entry: PillRunEntry }) {
    return (
        <YStack gap="1" minWidth={0} testID={`pill-run-entry-${entry.id}`}
            aria-label={entry.stop ? `${entry.from.name} stopped ${entry.to?.name ?? ''}` : heading(entry)}>
            <XStack gap="1" alignItems="center">
                <Pair from={entry.from} to={entry.to} stop={entry.stop} />
                <Copy small quiet>{`· ${entry.time}`}</Copy>
            </XStack>
            {/* A stop opens to its system line, like every other system message. */}
            {entry.body}
        </YStack>
    );
}

/**
 * The opened run: every message in send order under its own face → face
 * heading, in the transcript's text column (`TranscriptLine` with no sender).
 * Back-to-back events from one source share one GitHub or Beeline heading.
 * Rows sit the same-speaker 12 apart; a heading sits 4 above its body.
 */
function RunList({ run, targetId }: { targetId?: string; run: readonly PillRunEntry[] }) {
    return (
        <TranscriptLine testID="pill-open">
            <YStack gap="3" minWidth={0}>
                {runBlocks(run).map((block) => block.kind === 'events'
                    ? <EventGroup key={block.events[0]!.id} events={block.events} targetId={targetId} />
                    : <MessageEntry key={block.entry.id} entry={block.entry} />)}
            </YStack>
        </TranscriptLine>
    );
}

/**
 * Stops, agent-to-agent messages and GitHub and thread events in one wrapping row. Every
 * pill is faces and marks only; a tap opens the full message under the row.
 * A run folds into one pill of faces and a count ("5 messages · 13 events"),
 * and opens as a plain list in send order. A stop is face, stop glyph, face. A
 * lone event is its GitHub or Beeline ring and its state mark. A lone agent message is
 * a pill too, and opens on tap like any other.
 */
export function PillRow({ items, testID, targetId }: { targetId?: string; items: readonly PillItem[]; testID?: string }) {
    const [openId, setOpenId] = useState<string | null>(null);
    const targetItem = targetId && items.find(item => item.id === targetId || item.run?.some(entry => entry.id === targetId))?.id;
    useLayoutEffect(() => { if (targetItem) setOpenId(targetItem); }, [targetItem, targetId]);
    const open = items.find((item) => item.id === openId);
    return (
        <YStack gap="3" width="100%" minWidth={0} testID={testID ?? 'pill-row'}>
            <XStack gap="2" flexWrap="wrap" alignItems="flex-start">
                {items.map((item) => {
                    const expanded = item.id === openId;
                    return (
                        <Btn
                            key={item.id}
                            kind="secondary"
                            label={pillLabel(item, expanded)}
                            minHeight={HEIGHT.control}
                            maxWidth="100%"
                            paddingHorizontal="2"
                            gap={item.run ? '2' : '1'}
                            borderRadius="full"
                            borderColor={expanded ? 'strongStroke' : 'stroke'}
                            backgroundColor="raised"
                            aria-expanded={expanded}
                            onPress={() => setOpenId(expanded ? null : item.id)}
                            testID={item.run ? 'run-pill' : item.event ? 'event-pill' : item.stop ? 'stop-pill' : item.system ? 'system-pill' : 'agent-pill'}
                        >
                            {item.run ? (
                                <>
                                    <XStack gap="1" alignItems="center">
                                        {foldedFaces(item).map((face) => <Face key={faceKey(face)} face={face} />)}
                                    </XStack>
                                    <Copy small quiet numberOfLines={1}>{runCountLabel(item.run)}</Copy>
                                </>
                            ) : item.event ? (
                                <EventPair event={item.event} />
                            ) : (
                                <Pair from={item.from} to={item.to} stop={item.stop} />
                            )}
                        </Btn>
                    );
                })}
            </XStack>
            {open?.run ? <RunList run={open.run} targetId={targetId} /> : open ? (
                <TranscriptLine testID="pill-open">
                    {open.event ? <EventLine id={open.id} event={open.event} /> : open.body}
                </TranscriptLine>
            ) : null}
        </YStack>
    );
}
