import React, { useState } from 'react';
import { XStack, YStack } from 'tamagui';
import { ArrowRight, Square } from 'lucide-react-native';
import { Btn, Copy, Glyph, HEIGHT } from '@/ui/grammar';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { TranscriptLine } from './TranscriptLine';
import { SYSTEM_IDENTITY_PUBKEY } from '@/buzz/system-identity';

const PILL_FACE_SIZE = 22;

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
    /** Consecutive agent-to-agent messages folded into one pill: faces and a count. */
    run?: readonly PillRunEntry[];
    /** A system fact remains readable while its details are collapsed. */
    summary?: string;
    /** The message, read under the row once its pill is opened. */
    body: React.ReactNode;
    system: boolean;
};

function Face({ face }: { face: PillFace }) {
    if (face.kind === 'system') {
        return <IdentityMark kind="human" seed={SYSTEM_IDENTITY_PUBKEY} name={face.name} size={PILL_FACE_SIZE} />;
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

function names(faces: readonly PillFace[]): string {
    const all = faces.map((face) => face.name);
    return all.length <= 1 ? all.join('') : `${all.slice(0, -1).join(', ')} and ${all.at(-1)}`;
}

function pillLabel(item: PillItem, expanded: boolean): string {
    const verb = expanded ? 'Hide' : 'Read';
    if (item.run) return `${verb} ${item.run.length} messages between ${names(runFaces(item.run))}, ${item.time}`;
    if (item.stop) return `${item.from.name} stopped ${item.to?.name ?? ''}`;
    return `${verb} message from ${heading(item)}, ${item.time}`;
}

/** Two faces joined by an arrow, or by the stop glyph for a stop; a system summary sits after the first. */
function Pair({ from, to, stop, summary }: { from: PillFace; to?: PillFace; stop?: boolean; summary?: string }) {
    return (
        <>
            <Face face={from} />
            {summary ? <Copy small quiet numberOfLines={1} flexShrink={1}>{summary}</Copy> : null}
            {to ? (stop ? <Glyph icon={Square} size={14} accent filled /> : <Glyph icon={ArrowRight} size={14} />) : null}
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
 * System facts and agent-to-agent messages in one wrapping row. System pills
 * keep their summary visible; a tap opens the full message under the row.
 * A run of agent messages folds into one pill of faces and a count, and opens
 * as a plain list in send order. A stop is face, stop glyph, face.
 */
export function PillRow({ items, testID }: { items: readonly PillItem[]; testID?: string }) {
    const [openId, setOpenId] = useState<string | null>(null);
    const open = items.find((item) => item.id === openId);
    return (
        <YStack gap="2" width="100%" minWidth={0} testID={testID ?? 'pill-row'}>
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
                                    <XStack>
                                        {runFaces(item.run).map((face) => (
                                            // A 2 px ring in the pill's own fill keeps adjacent faces apart
                                            // (the grammar has no negative spacing, so faces sit side by side).
                                            <YStack key={faceKey(face)} borderWidth={2}
                                                borderColor="raised" borderRadius="sm"><Face face={face} /></YStack>
                                        ))}
                                    </XStack>
                                    <Copy small quiet numberOfLines={1}>{`${item.run.length} messages`}</Copy>
                                </>
                            ) : (
                                <Pair from={item.from} to={item.to} stop={item.stop}
                                    summary={item.system && !item.stop ? item.summary : undefined} />
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
