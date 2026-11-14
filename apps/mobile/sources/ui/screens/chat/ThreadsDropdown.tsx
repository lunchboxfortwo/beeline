import React, { useCallback, useContext, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Platform, useWindowDimensions } from 'react-native';
import { Collapsible, ScrollView, Separator, XStack, YStack } from 'tamagui';
import { ChevronDown, ChevronUp, CornerDownRight } from 'lucide-react-native';
import { cornerShortTitle, type ChatListCorner, type CornerState } from '@beeline/api-contract/phone';
import { useRoomCornerSummary } from '@/buzz/room-corner-store';
import { useRoomCorners } from '@/buzz/use-room-corners';
import { Btn, Copy, Glyph, HEIGHT } from '@/ui/grammar';
import { ForwardCornerSheet } from '@/components/buzz/ForwardCornerSheet';
import { ThreadLine } from '@/ui/screens/thread/ThreadLine';

/** The list is at most this share of the window and scrolls inside itself. */
export const THREADS_DROPDOWN_SHARE = 0.45;

type Line = Pick<ChatListCorner, 'id' | 'blocker' | 'reason'> & { title: string; state: CornerState };

const DropdownContext = React.createContext<{
    open: boolean; setOpen: (open: boolean) => void;
} | null>(null);

/** Outside touches dismiss without claiming the responder or consuming the tap. */
export function ThreadsDropdownScope({ children }: { children: React.ReactNode }) {
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);
    useFocusEffect(useCallback(() => close, [close]));
    return <DropdownContext.Provider value={{ open, setOpen }}>
        <YStack flex={1} onTouchStart={close} {...(Platform.OS === 'web' ? { onPointerDown: close } : {})} testID="threads-dismiss-scope">{children}</YStack>
    </DropdownContext.Provider>;
}

/**
 * "Threads · N active" under the chat header. The count is the Room's
 * server corner summary; opening it reads the Room's open corner pages.
 */
export function ThreadsDropdown({ roomId, chatName, viewer, openThread, onNewThread, newThreadDisabled = false }: {
    roomId: string; chatName: string | null; openThread: (cornerId: string) => void;
    onNewThread: () => void; newThreadDisabled?: boolean;
    /** The viewer's identity id; a thread waiting on them reads "waiting on you". */
    viewer?: string;
}) {
    const [newThreadPrompt, setNewThreadPrompt] = useState(false);
    const summary = useRoomCornerSummary(roomId);
    const local = useState(false);
    const scope = useContext(DropdownContext);
    const { open, setOpen } = scope ?? { open: local[0], setOpen: local[1] };
    const count = summary?.cornerCount ?? 0;
    return (
        <YStack testID="threads-dropdown" onTouchStart={event => event.stopPropagation()}
            // Tamagui's native pointer adapter drops SyntheticEvent prototype
            // methods. Native containment uses the original touch event instead.
            {...(Platform.OS === 'web' ? { onPointerDown: (event: React.PointerEvent) => event.stopPropagation() } : {})}>
            <Collapsible open={open} onOpenChange={setOpen}>
                <XStack marginHorizontal="3" backgroundColor="raised" borderRadius="sm" alignItems="center">
                    <Collapsible.Trigger asChild>
                        <Btn
                            kind="quiet" label={`${count} active threads in ${chatName ?? 'this chat'}`}
                            flex={1} minWidth={HEIGHT.control} height="auto" justifyContent="flex-start" gap="1" aria-expanded={open}
                            testID="threads-dropdown-trigger"
                        >
                            <Copy small>{`Threads · ${count} active`}</Copy>
                            <Glyph icon={open ? ChevronUp : ChevronDown} size={14} />
                        </Btn>
                    </Collapsible.Trigger>
                    <Separator vertical borderColor="stroke" height="4" />
                    <Btn kind="quiet" label="New thread" gap="1" flexShrink={1} minWidth={HEIGHT.control} height="auto"
                        disabled={newThreadDisabled} testID="threads-new-thread"
                        onPress={() => { setOpen(false); setNewThreadPrompt(true); }}>
                        <Glyph icon={CornerDownRight} size={16} />
                        <Copy small>New thread</Copy>
                    </Btn>
                </XStack>
                <Collapsible.Content>
                    {open ? <ThreadsDropdownList roomId={roomId} chatName={chatName} count={count}
                        fallback={summary?.openCorners ?? []} viewer={viewer} openThread={openThread} /> : null}
                </Collapsible.Content>
            </Collapsible>
            {newThreadPrompt ? <ForwardCornerSheet visible fromMessage={false}
                onClose={() => setNewThreadPrompt(false)}
                onOpen={() => { setNewThreadPrompt(false); onNewThread(); }} /> : null}
            <Separator borderColor="stroke" marginTop="2" />
        </YStack>
    );
}

function ThreadsDropdownList({ roomId, chatName, count, fallback, viewer, openThread }: {
    roomId: string; chatName: string | null; count: number; viewer?: string;
    fallback: readonly ChatListCorner[];
    openThread: (cornerId: string) => void;
}) {
    const { height } = useWindowDimensions();
    const corners = useRoomCorners(roomId, null, false);
    const lines: Line[] = corners.openRows.length
        ? corners.openRows.map((row) => ({ id: row.corner.id, title: cornerShortTitle(chatName, row.corner.name, row.corner.id),
            state: row.state, blocker: row.blocker, reason: row.reason }))
        : fallback.map((corner) => ({ id: corner.id, title: cornerShortTitle(chatName, corner.name, corner.id),
            state: corner.state, blocker: corner.blocker, reason: corner.reason }));
    const more = corners.record?.nextOpen ? Math.max(0, count - lines.length) : 0;
    return (
        <ScrollView maxHeight={Math.round(height * THREADS_DROPDOWN_SHARE)} keyboardShouldPersistTaps="handled" testID="threads-dropdown-list">
            <YStack marginLeft="6" marginRight="4" marginTop="1" paddingLeft="3" borderLeftWidth={1} borderColor="strongStroke">
                {lines.map((line) => (
                    <ThreadLine key={line.id} title={line.title} state={line.state} blocker={line.blocker} reason={line.reason} viewer={viewer}
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
