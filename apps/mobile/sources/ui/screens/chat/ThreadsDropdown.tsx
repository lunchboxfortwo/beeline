import React, { useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { Collapsible, ScrollView, Separator, YStack } from 'tamagui';
import { ChevronDown, ChevronUp, CornerDownRight } from 'lucide-react-native';
import { cornerShortTitle, type CornerState } from '@beeline/api-contract/phone';
import { useRoomCornerSummary } from '@/buzz/room-corner-store';
import { useRoomCorners } from '@/buzz/use-room-corners';
import { Btn, Copy, Glyph } from '@/ui/grammar';
import { ThreadLine } from '@/ui/screens/thread/ThreadLine';

/** The list is at most this share of the window and scrolls inside itself. */
export const THREADS_DROPDOWN_SHARE = 0.45;

type Line = { id: string; title: string; state: CornerState };

/**
 * "Threads · N active" under the chat header. The count is the Room's
 * server corner summary; opening it reads the Room's open corner pages.
 */
export function ThreadsDropdown({ roomId, chatName, openThread, repositoryAvatar, repositoryFavicon }: {
    repositoryAvatar?: string; repositoryFavicon?: string;
    roomId: string; chatName: string | null; openThread: (cornerId: string) => void;
}) {
    const summary = useRoomCornerSummary(roomId);
    const [open, setOpen] = useState(false);
    const count = summary?.cornerCount ?? 0;
    // The hairline under the chat header stays when there are no threads.
    if (!count) return <Separator borderColor="stroke" marginTop="2" />;
    return (
        <YStack testID="threads-dropdown">
            <Collapsible open={open} onOpenChange={setOpen}>
                <Collapsible.Trigger asChild>
                    <Btn
                        kind="quiet" label={`${count} active threads in ${chatName ?? 'this chat'}`}
                        marginHorizontal="3" backgroundColor="raised" justifyContent="flex-start" gap="1" aria-expanded={open}
                        testID="threads-dropdown-trigger"
                    >
                        <Copy small>{`Threads · ${count} active`}</Copy>
                        <Glyph icon={open ? ChevronUp : ChevronDown} size={14} />
                    </Btn>
                </Collapsible.Trigger>
                <Collapsible.Content>
                    {open ? <ThreadsDropdownList repositoryAvatar={repositoryAvatar} repositoryFavicon={repositoryFavicon} roomId={roomId} chatName={chatName} count={count}
                        fallback={summary?.openCorners ?? []} openThread={openThread} /> : null}
                </Collapsible.Content>
            </Collapsible>
            <Separator borderColor="stroke" marginTop="2" />
        </YStack>
    );
}

function ThreadsDropdownList({ roomId, chatName, count, fallback, openThread, repositoryAvatar, repositoryFavicon }: {
    repositoryAvatar?: string; repositoryFavicon?: string;
    roomId: string; chatName: string | null; count: number;
    fallback: readonly { id: string; name: string; state: CornerState }[];
    openThread: (cornerId: string) => void;
}) {
    const { height } = useWindowDimensions();
    const corners = useRoomCorners(roomId, null, false);
    const lines: Line[] = corners.openRows.length
        ? corners.openRows.map((row) => ({ id: row.corner.id, title: cornerShortTitle(chatName, row.corner.name, row.corner.id), state: row.state }))
        : fallback.map((corner) => ({ id: corner.id, title: cornerShortTitle(chatName, corner.name, corner.id), state: corner.state }));
    const more = corners.record?.nextOpen ? Math.max(0, count - lines.length) : 0;
    return (
        <ScrollView maxHeight={Math.round(height * THREADS_DROPDOWN_SHARE)} testID="threads-dropdown-list">
            <YStack marginLeft="6" marginRight="4" marginTop="1" paddingLeft="3" borderLeftWidth={1} borderColor="strongStroke">
                {lines.map((line) => (
                    <ThreadLine avatarUrl={repositoryAvatar} faviconUrl={repositoryFavicon} key={line.id} title={line.title} state={line.state}
                        onPress={() => openThread(line.id)} testID={`thread-row-${line.id}`} />
                ))}
                {more ? (
                    <Btn kind="quiet" label={`${more} more threads`} justifyContent="flex-start" gap="2"
                        onPress={() => void corners.loadMoreOpen()} testID="threads-dropdown-more">
                        <Glyph icon={CornerDownRight} size={16} />
                        <Copy small quiet>{`${more} more`}</Copy>
                    </Btn>
                ) : null}
            </YStack>
        </ScrollView>
    );
}
