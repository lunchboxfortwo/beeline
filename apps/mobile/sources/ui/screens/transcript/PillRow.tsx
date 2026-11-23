import React, { useState } from 'react';
import { XStack, YStack, useThemeName } from 'tamagui';
import { ArrowRight, CircleX, CornerDownRight, GitMerge, GitPullRequest, GitPullRequestClosed } from 'lucide-react-native';
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
/** An opened group of GitHub events longer than this shows two and an "N more" row. */
const EVENT_GROUP_SHOWN = 3;

/** One end of a pill: the Beeline account, GitHub, a person or an agent. */
export type PillFace =
    | { kind: 'system'; name: string }
    | { kind: 'github'; name: string }
    | { kind: 'agent' | 'human'; seed: string; name: string; face?: string; avatarUrl?: string };

/** A GitHub PR, issue, commit, check or thread-opened event, as one pill or one opened row. */
export type PillEvent = {
    /** The mark a lone event pill shows beside the GitHub ring. */
    mark?: 'opened' | 'merged' | 'closed' | 'failed' | 'thread';
    /** "Merged", in ink. Empty when `text` says it all. */
    verb: string;
    /** The PR or issue number, in brass. */
    number?: string;
    /** The PR, issue, check or thread title, in secondary. */
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
    /** A GitHub event: `from` is the GitHub face, and the row reads the event, not a message. */
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
    /** A lone GitHub event: the GitHub ring and its state mark, with no text. */
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

const BEELINE_FACE: PillFace = { kind: 'system', name: 'Beeline' };
export const GITHUB_FACE: PillFace = { kind: 'github', name: 'GitHub' };

/** A Beeline notice, a person's stop included; an agent's stop reads as part of the agents' talk. */
export function isNotice(entry: PillRunEntry): boolean {
    return Boolean(entry.system) && !(entry.stop && entry.from.kind === 'agent');
}

/**
 * The faces a folded run shows, at most `RUN_FACES`. A run that holds a Beeline
 * notice leads with the ringed Beeline logo, then whoever stopped a turn, then
 * everyone else, so a person's stop stays visible while folded.
 */
function foldedFaces(item: PillItem): PillFace[] {
    const run = item.run ?? [];
    const notice = (entry: PillRunEntry) => item.system || isNotice(entry);
    // GitHub events lead with the GitHub ring, so a folded merge still shows.
    const github = run.some((entry) => entry.event) ? [GITHUB_FACE] : [];
    if (!run.some(notice) && !github.length) return runFaces(run).slice(0, RUN_FACES);
    const stoppers = run.filter((entry) => entry.stop && notice(entry)).map((entry) => entry.from);
    const seen = new Set<string>();
    const lead = run.some(notice) ? [BEELINE_FACE, ...github] : github;
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

/** A run's messages and its counted GitHub events. */
function runCounts(run: readonly PillRunEntry[]): { messages: number; events: number } {
    return {
        messages: run.filter((entry) => !entry.event).length,
        events: run.filter((entry) => entry.event?.counted).length,
    };
}

/** The folded run's visible count: "5 messages · 13 events", dropping an absent kind. */
export function runCountLabel(run: readonly PillRunEntry[]): string {
    const { messages, events } = runCounts(run);
    return [messages ? plural(messages, 'message') : '', events ? plural(events, 'event') : '']
        .filter(Boolean).join(' · ');
}

function pillLabel(item: PillItem, expanded: boolean): string {
    const verb = expanded ? 'Hide' : 'Read';
    if (item.event) return `${verb} GitHub event: ${item.event.spoken}, ${item.time}`;
    if (item.run?.some((entry) => entry.event)) {
        const { messages, events } = runCounts(item.run);
        const parts = [messages ? plural(messages, 'message') : '', events ? plural(events, 'GitHub event') : ''].filter(Boolean);
        const between = names(runFaces(item.run).filter((face) => face.kind !== 'system' && face.kind !== 'github'));
        const notices = item.run.filter(isNotice).length;
        return `${verb} ${parts.join(' and ')}${between ? ` between ${between}` : ''}${notices ? `, ${notices} from Beeline` : ''}, ${item.time}`;
    }
    if (item.run && item.system) {
        const about = runFaces(item.run).filter((face) => face.kind !== 'system');
        return `${verb} ${item.run.length} system messages${about.length ? ` about ${names(about)}` : ''}, ${item.time}`;
    }
    if (item.run) {
        const between = names(runFaces(item.run).filter((face) => face.kind !== 'system'));
        const notices = item.run.filter(isNotice).length;
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

/** The ring pair of a lone event pill: GitHub, then the event's state mark. */
function EventPair({ event }: { event: PillEvent }) {
    const Mark = event.mark ? EVENT_MARKS[event.mark] : undefined;
    return (
        <>
            <Face face={GITHUB_FACE} />
            {Mark ? <Ring testID={`pill-event-mark-${event.mark}`}><Glyph icon={Mark} size={14} /></Ring> : null}
        </>
    );
}

/** One opened event in body type: verb in ink, #number in brass, title in secondary, and a brass chevron when it opens. */
function EventLine({ entry }: { entry: PillRunEntry & { event: PillEvent } }) {
    const { event } = entry;
    const copy = (
        <T v="body" color="secondary" numberOfLines={2} ellipsizeMode="tail" testID={`pill-event-text-${entry.id}`}>
            {event.text ? <T v="body" color="ink">{event.text}</T> : <>
                {event.verb ? <T v="body" color="ink">{`${event.verb} `}</T> : null}
                {event.number ? <T v="body" color="needsYou">{`#${event.number} `}</T> : null}
                {event.title}
            </>}
        </T>
    );
    if (!event.open) {
        return <YStack minHeight={HEIGHT.control} justifyContent="center" testID={`pill-event-${entry.id}`}
            accessible accessibilityLabel={event.spoken}>{copy}</YStack>;
    }
    return (
        <TranscriptNavigationRow testID={`pill-event-${entry.id}`} singleDestination
            trailing={{ accessibilityLabel: `${event.spoken}. ${event.open.label}`, onPress: event.open.onPress, testID: `pill-event-open-${entry.id}` }}>
            {copy}
        </TranscriptNavigationRow>
    );
}

/** Back-to-back GitHub events under one "GitHub ring · time" heading; more than three show two and "N more". */
function EventGroup({ events }: { events: readonly (PillRunEntry & { event: PillEvent })[] }) {
    const [all, setAll] = useState(false);
    const first = events[0]!;
    const shown = all || events.length <= EVENT_GROUP_SHOWN ? events : events.slice(0, 2);
    return (
        <YStack gap="1" minWidth={0} testID={`pill-event-group-${first.id}`}>
            <XStack gap="1" alignItems="center" accessibilityLabel={`GitHub, ${first.time}`}>
                <Face face={GITHUB_FACE} />
                <Copy small quiet>{`· ${first.time}`}</Copy>
            </XStack>
            <YStack minWidth={0}>
                {shown.map((entry) => <EventLine key={entry.id} entry={entry} />)}
                {shown.length < events.length ? (
                    <LedgerDisclosure expanded={false} accessibilityState={{ expanded: false }}
                        accessibilityLabel={`${events.length - shown.length} more GitHub events`} onPress={() => setAll(true)}
                        rowTestID={`pill-event-more-${first.id}`}>{`${events.length - shown.length} more`}</LedgerDisclosure>
                ) : null}
            </YStack>
        </YStack>
    );
}

type RunBlock =
    | { kind: 'message'; entry: PillRunEntry }
    | { kind: 'events'; events: (PillRunEntry & { event: PillEvent })[] };

/** Send order, with back-to-back events gathered under one heading. */
function runBlocks(run: readonly PillRunEntry[]): RunBlock[] {
    const blocks: RunBlock[] = [];
    for (const entry of run) {
        const last = blocks.at(-1);
        if (entry.event) {
            const event = entry as PillRunEntry & { event: PillEvent };
            if (last?.kind === 'events') last.events.push(event);
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
 * Back-to-back GitHub events share one GitHub heading.
 * Rows sit the same-speaker 12 apart; a heading sits 4 above its body.
 */
function RunList({ run }: { run: readonly PillRunEntry[] }) {
    return (
        <TranscriptLine testID="pill-open">
            <YStack gap="3" minWidth={0}>
                {runBlocks(run).map((block) => block.kind === 'events'
                    ? <EventGroup key={block.events[0]!.id} events={block.events} />
                    : <MessageEntry key={block.entry.id} entry={block.entry} />)}
            </YStack>
        </TranscriptLine>
    );
}

/**
 * Stops, agent-to-agent messages and GitHub events in one wrapping row. Every
 * pill is faces and marks only; a tap opens the full message under the row.
 * A run folds into one pill of faces and a count ("5 messages · 13 events"),
 * and opens as a plain list in send order. A stop is face, stop glyph, face. A
 * lone event is the GitHub ring and its state mark. A lone agent message has
 * nothing to fold, so it reads as its open row with no pill.
 */
export function PillRow({ items, testID }: { items: readonly PillItem[]; testID?: string }) {
    const [openId, setOpenId] = useState<string | null>(null);
    const open = items.find((item) => item.id === openId);
    const lone = items.length === 1 && !items[0]!.run && !items[0]!.stop && !items[0]!.system && !items[0]!.event ? items[0] : undefined;
    if (lone) {
        return (
            <YStack width="100%" minWidth={0} testID={testID ?? 'pill-row'}>
                <RunList run={[lone]} />
            </YStack>
        );
    }
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
            {/* A lone pill opens exactly like a run of one: same column, same heading, same tone. */}
            {open ? <RunList run={open.run ?? [open]} /> : null}
        </YStack>
    );
}
