import React from 'react';
import { router } from 'expo-router';
import { XStack, YStack } from 'tamagui';
import type { AgentDetailView } from '@beeline/buzz-client';
import { roomTitle } from '@beeline/api-contract/phone';
import { navigateToRoom } from '@/buzz/corner-navigation';
import { Copy, Row, Section, T } from '@/ui/grammar';

/** The profile head: a 72 mark, the @handle as the title, one quiet line. */
export function ProfileHead({ mark, title, line, testID }: { mark: React.ReactNode; title: string; line?: string; testID?: string }) {
    return (
        <XStack gap="4" alignItems="center" testID={testID}>
            {mark}
            <YStack flex={1} minWidth={0} gap="1">
                <T v="title">{title}</T>
                {line ? <Copy small quiet>{line}</Copy> : null}
            </YStack>
        </XStack>
    );
}

/** Chats as rows: #name, opening the chat. */
export function ChatRows({ title, rooms }: { title: string; rooms: readonly { id: string; name: string }[] }) {
    if (!rooms.length) return null;
    return (
        <Section title={title} testID="profile-chats">
            {rooms.map((room, index) => (
                <Row key={room.id} label={roomTitle(room.name) ?? room.name}
                    onPress={() => navigateToRoom(router, room.id)} testID={`profile-chat-${room.id}`} last={index === rooms.length - 1} />
            ))}
        </Section>
    );
}

/**
 * What the access switch means right now, naming the owner by @handle. This
 * is the only gate before an agent acts on its owner's machine, so the
 * "everyone" state says exactly what that grants.
 */
export function accessCaption(access: AgentDetailView['access'], agentName: string): string {
    const change = 'Only the owner can change this.';
    if (access?.policy === 'everyone')
        return `Anyone in the chat can have ${agentName} run commands, install software and change ` +
            `configuration on your machine. Turn this off and only you may ask them.`;
    if (access?.policy === 'allowlist') return `Only allowed members may ask this agent. ${change}`;
    const owner = access?.owner?.handle ? `@${access.owner.handle}` : 'the owner';
    return `Only ${owner} may ask this agent; everyone else is told to ask ${owner} here. ${change}`;
}

/** What yolo means for this agent, and the two things that still ask. */
export function yoloCaption(agentName: string, forcedOff = false): string {
    if (forcedOff) return 'Yolo is forced off while this workspace is public.';
    return `${agentName} acts without stopping to ask. Two things still ask you: anything that names ` +
        `one of your credentials, and a script nobody has read.`;
}

export function yoloSetByLine(yolo: NonNullable<AgentDetailView['yolo']>): string | null {
    if (!yolo.enabled || !yolo.setBy) return null;
    const date = yolo.setAt === undefined ? null
        : new Date(yolo.setAt * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    return date ? `Set by ${yolo.setBy.name} · ${date}` : `Set by ${yolo.setBy.name}`;
}
