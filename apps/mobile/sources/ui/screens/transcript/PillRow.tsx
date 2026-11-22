import React, { useState } from 'react';
import { XStack, YStack } from 'tamagui';
import { ArrowRight } from 'lucide-react-native';
import { Btn, Copy, Glyph, HEIGHT } from '@/ui/grammar';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { TranscriptLine } from './TranscriptLine';
import { SYSTEM_IDENTITY_PUBKEY } from '@/buzz/system-identity';

const PILL_FACE_SIZE = 22;
/** The Beeline logo inside the system circle: 22 less the ring and a 3 px inset. */
const SYSTEM_MARK_SIZE = 14;
/** The solid stop square inside its ring: small enough to read as a stop button, not a checkbox. */
const STOP_SQUARE_SIZE = 8;
/** A folded run shows at most this many faces; opening it (and its label) shows everyone. */
const RUN_FACES = 3;

/** One end of a pill: the Beeline account, a person or an agent. */
export type PillFace =
    | { kind: 'system'; name: string }
    | { kind: 'agent' | 'human'; seed: string; name: string; face?: string; avatarUrl?: string };

/** One message of a folded agent run, read in send order once the run opens. */
export type PillRunEntry = {
    id: string;
    from: PillFace;
    to?: PillFace;
    time: string;
    /** A stop: drawn face, stop glyph, face, with no text. */
    stop?: boolean;
    body?: React.ReactNode;
};

export type PillItem = {
    id: string;
    from: PillFace;
    to?: PillFace;
    time: string;
    /** A stop of an agent's turn: face, stop glyph, face, with no text. */
    stop?: boolean;
    /** Consecutive agent-to-agent messages, or consecutive system notices, folded into one pill: faces and a count. */
    run?: readonly PillRunEntry[];
    /** A system fact's text: the folded pill's accessibility label; it shows only once opened. */
    summary?: string;
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

function Face({ face }: { face: PillFace }) {
    if (face.kind === 'system') {
        // The Beeline account reads as a bot face: its logo inside a ring, the size of every other face.
        return (
            <Ring testID="pill-system-face">
                <IdentityMark kind="human" seed={SYSTEM_IDENTITY_PUBKEY} name={face.name} size={SYSTEM_MARK_SIZE} />
            </Ring>
        );
    }
    return face.kind === 'agent'
        ? <IdentityMark kind="agent" seed={face.seed} face={face.face} avatarUrl={face.avatarUrl} name={face.name} size={PILL_FACE_SIZE} />
        : <IdentityMark kind="human" seed={face.seed} face={face.face} avatarUrl={face.avatarUrl} name={face.name} size={PILL_FACE_SIZE} />;
}

function heading(item: Pick<PillItem, 'from' | 'to'>): string {
    return item.to ? `${item.from.name} → ${item.to.name}` : item.from.name;
}

function faceKey(face: PillFace): string {
    return face.kind === 'system' ? SYSTEM_IDENTITY_PUBKEY : face.seed;
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

/**
 * The faces a folded run shows, at most `RUN_FACES`. A system stack always
 * leads with the ringed Beeline logo, then whoever stopped a turn, then the
 * other subjects, so a person's stop stays visible while folded.
 */
function foldedFaces(item: PillItem): PillFace[] {
    const run = item.run ?? [];
    if (!item.system) return runFaces(run).slice(0, RUN_FACES);
    const stoppers = run.filter((entry) => entry.stop).map((entry) => entry.from);
    const seen = new Set<string>();
    const ordered = [BEELINE_FACE, ...stoppers, ...runFaces(run)].filter((face) => {
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

function pillLabel(item: PillItem, expanded: boolean): string {
    const verb = expanded ? 'Hide' : 'Read';
    if (item.run && item.system) {
        const about = runFaces(item.run).filter((face) => face.kind !== 'system');
        return `${verb} ${item.run.length} system messages${about.length ? ` about ${names(about)}` : ''}, ${item.time}`;
    }
    if (item.run) return `${verb} ${item.run.length} messages between ${names(runFaces(item.run))}, ${item.time}`;
    if (item.stop) return `${item.from.name} stopped ${item.to?.name ?? ''}`;
    if (item.system && item.summary) return `${verb} ${item.summary}, ${item.time}`;
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

/**
 * The opened run: every message in send order under its own face → face
 * heading, in the transcript's text column (`TranscriptLine` with no sender).
 * Rows sit the same-speaker 12 apart; a heading sits 4 above its body.
 */
function RunList({ run }: { run: readonly PillRunEntry[] }) {
    return (
        <TranscriptLine testID="pill-open">
            <YStack gap="3" minWidth={0}>
                {run.map((entry) => (
                    <YStack key={entry.id} gap="1" minWidth={0} testID={`pill-run-entry-${entry.id}`}
                        aria-label={entry.stop ? `${entry.from.name} stopped ${entry.to?.name ?? ''}` : heading(entry)}>
                        <XStack gap="1" alignItems="center">
                            <Pair from={entry.from} to={entry.to} stop={entry.stop} />
                            <Copy small quiet>{`· ${entry.time}`}</Copy>
                        </XStack>
                        {entry.stop ? null : entry.body}
                    </YStack>
                ))}
            </YStack>
        </TranscriptLine>
    );
}

/**
 * System facts and agent-to-agent messages in one wrapping row. Every pill is
 * faces only; a tap opens the full message under the row.
 * A run of agent messages folds into one pill of faces and a count, and opens
 * as a plain list in send order. A stop is face, stop glyph, face.
 */
export function PillRow({ items, testID }: { items: readonly PillItem[]; testID?: string }) {
    const [openId, setOpenId] = useState<string | null>(null);
    const open = items.find((item) => item.id === openId);
    return (
        <YStack gap={open?.run ? '3' : '2'} width="100%" minWidth={0} testID={testID ?? 'pill-row'}>
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
                            testID={item.run ? 'run-pill' : item.stop ? 'stop-pill' : item.system ? 'system-pill' : 'agent-pill'}
                        >
                            {item.run ? (
                                <>
                                    <XStack gap="1" alignItems="center">
                                        {foldedFaces(item).map((face) => <Face key={faceKey(face)} face={face} />)}
                                    </XStack>
                                    <Copy small quiet numberOfLines={1}>{`${item.run.length} messages`}</Copy>
                                </>
                            ) : (
                                <Pair from={item.from} to={item.to} stop={item.stop} />
                            )}
                        </Btn>
                    );
                })}
            </XStack>
            {open?.run ? <RunList run={open.run} /> : open ? (
                <YStack paddingLeft="2" borderLeftWidth={2} borderColor="stroke" gap="1" testID="pill-open">
                    <Copy small quiet>{`${heading(open)} · ${open.time}`}</Copy>
                    {open.body}
                </YStack>
            ) : null}
        </YStack>
    );
}
