import { RepositoryMark } from '@/components/buzz/RepositoryMark';
import React, {useState} from 'react';
import { WorkAvatar, WorkAssigneePicker } from '@/ui/screens/tags/WorkBoard';
import { WorkStateMark } from '@/ui/screens/tags/WorkMarks';
import type { WorkItemView, RoomViewIdentity } from '@beeline/api-contract/phone';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import type { View } from 'react-native';
import { ListItem, XStack, YStack, useThemeName } from 'tamagui';
import { ArrowLeft, Users, CornerDownRight, GitPullRequest, MoreHorizontal } from 'lucide-react-native';
import { threadWorkMark, type CornerBlocker, type CornerState, type CornerStateReason } from '@beeline/api-contract/phone';
import { Btn, Glyph, HEIGHT, SafeTop, T, typeStyle, useTextSize } from '@/ui/grammar';

/**
 * Header B (the only thread header). A slim bar keeps Back, the chat (opens
 * it) and ⋯; the title, pull request and objective are the first
 * block of the transcript. Once that block scrolls away, the bar takes the
 * title with the work-state glyph. A small scroll up, or a tap on that title, shows
 * the full header under the bar until the reader scrolls down.
 * The running session name supplies the working sentence.
 */
export type ThreadHeaderData = {
    /** `#beeline`, or null while the parent's name has not landed. */
    workItem?:WorkItemView;
    people?:readonly RoomViewIdentity[];
    chatTag: string | null;
    title: string;
    repositoryHomepageIcon?: string;
    /** Undefined until the parent Room's corner row lands. */
    state?: CornerState;
    workingAgentName?: string;
    /** The machine's reason alongside `state` (`backlog` on an idle thread). */
    reason?: CornerStateReason;
    /** While waiting, whom the thread waits on; it needs `viewer` only when that is them. */
    blocker?: CornerBlocker;
    viewer?: string;
    prLine?: string;
    objective?: string;
};

/** Each run is indivisible on native and web; flex may wrap only after its trailing hyphen.
 * `trail` (the state mark) follows the last run, centred on its line. */
function ThreadName({ title, v, regular = false, testID, trail }: {
    title: string; v: 'title' | 'meta' | 'metaStrong'; regular?: boolean; testID?: string; trail?: React.ReactNode;
}) {
    const parts = title.match(/[^-]*-|[^-]+$/g) ?? [''];
    const line = typeStyle(v, useTextSize()).lineHeight;
    return (
        <XStack flexShrink={1} minWidth={0} flexWrap="wrap" alignItems="center" accessible accessibilityLabel={title}
            aria-label={title} testID={testID}>
            {parts.map((part, index) => (
                <T key={index} v={v} regular={regular} color="ink" numberOfLines={1} flexShrink={0}>{part}</T>
            ))}
            {trail ? <YStack height={line} marginLeft="2" alignItems="center" justifyContent="center" testID={testID ? `${testID}-state` : undefined}>{trail}</YStack> : null}
        </XStack>
    );
}

/** The thread's state mark for this viewer: a wait on anyone else reads idle. */
function headerMark(h: ThreadHeaderData) {
    return h.state ? threadWorkMark({ state: h.state, reason: h.reason, blocker: h.blocker }, h.viewer) : undefined;
}

function HeaderMark({ h }: { h: ThreadHeaderData }) {
    const mark = headerMark(h);
    return mark ? <WorkStateMark state={mark.state} idle={mark.idle} /> : null;
}

export function ThreadBar({ h, collapsed, expanded, back, openChat, expand, openActions, safeTop = true, barRef, onBarLayout }: {
    h: ThreadHeaderData; collapsed: boolean;
    /** The full header, shown under the bar while the title block is away. */
    expanded?: React.ReactNode;
    back?: () => void; openChat: () => void;
    expand?: () => void; openActions?: () => void; safeTop?: boolean;
    barRef?: React.Ref<View>; onBarLayout?: () => void;
}) {
    const lineHeight = typeStyle('meta', useTextSize()).lineHeight;
    return (
        <YStack backgroundColor="raised" borderBottomWidth={1} borderColor="stroke" testID="corner-session-header">
            <YStack ref={barRef as never} onLayout={onBarLayout}>
                {safeTop ? <SafeTop fill="raised" /> : null}
                <XStack paddingHorizontal="4" paddingVertical="1" gap="2" alignItems="center" testID="thread-header">
                    {back ? <Btn kind="icon" label="Back" onPress={back} testID="chat-back"><Glyph icon={ArrowLeft} /></Btn> : null}
                    <XStack flex={1} minWidth={0} gap="2" alignItems="center">
                        <RepositoryMark homepageIconUrl={h.repositoryHomepageIcon} size={28} />
                        {/* The chat and the title stack, so each wraps across the bar's full width and neither starves the other. */}
                        <YStack flex={1} minWidth={0} justifyContent="center" minHeight={HEIGHT.control} testID="thread-bar-names">
                            {h.chatTag ? (
                                <ListItem padding="0" minHeight={0} alignSelf="flex-start" width="auto" maxWidth="100%"
                                    backgroundColor="transparent" justifyContent="flex-start" onPress={openChat}
                                    aria-label={`Open chat ${h.chatTag}`} accessibilityRole="button" testID="thread-chat-link">
                                    <T v="meta" color="secondary" flexShrink={1}>{h.chatTag}</T>
                                </ListItem>
                            ) : null}
                            {collapsed && !expanded ? (
                                <ListItem padding="0" minHeight={0} gap="2" alignItems="center"
                                    backgroundColor="transparent" justifyContent="flex-start" onPress={expand}
                                    aria-label={h.title} accessibilityRole={expand ? 'button' : 'text'} testID="thread-bar-title">
                                    <YStack height={lineHeight} alignSelf="flex-start" justifyContent="center" testID="thread-bar-arrow-box"><Glyph icon={CornerDownRight} size={16} /></YStack>
                                    <ThreadName title={h.title} v={headerMark(h)?.state === 'needs-you' ? "metaStrong" : "meta"} testID="thread-bar-name" trail={<HeaderMark h={h} />} />
                                </ListItem>
                            ) : null}
                            {h.workingAgentName ? <T v="meta" color="needsYou" testID="thread-header-working">{`${h.workingAgentName} is working`}</T> : null}
                        </YStack>
                    </XStack>
                    {openActions ? (
                        <Btn kind="icon" label="Thread actions" onPress={openActions} testID="corner-actions-menu">
                            <Glyph icon={MoreHorizontal} />
                        </Btn>
                    ) : null}
                </XStack>
            </YStack>
            {expanded}
        </YStack>
    );
}

/** The transcript's first (oldest) block: state glyph, title, avatars, PR and objective. */
export function ThreadTitleBlock({ h, openBrief, openPr, blockRef, onBlockLayout, inset = true }: {
    h: ThreadHeaderData; openBrief?: () => void; openPr?: () => void;
    blockRef?: React.Ref<View>; onBlockLayout?: () => void; inset?: boolean;
}) {
    const lineHeight = typeStyle('title', useTextSize()).lineHeight;
    const [assigneeOpen, setAssigneeOpen] = useState(false);
    const stone = useThemeName().includes('stone');
    return (
        <YStack ref={blockRef as never} onLayout={onBlockLayout} width="100%" maxWidth={720} alignSelf="center"
            paddingHorizontal={inset ? "4" : "0"} paddingTop={inset ? "4" : "0"} paddingBottom="3" gap="2" borderBottomWidth={1} borderColor="stroke"
            testID="thread-title-block">
            <XStack gap="2" alignItems="center" testID="thread-title-row">
                <YStack height={lineHeight} alignSelf="flex-start" justifyContent="center" testID="thread-arrow-box"><Glyph icon={CornerDownRight} size={18} /></YStack>
                <YStack flex={1} minWidth={0}><ThreadName title={h.title} v="title" regular={headerMark(h)?.state !== 'needs-you'} testID="thread-title" trail={<HeaderMark h={h} />} /></YStack>
                {h.workItem ? <Btn kind="quiet" label="Change assignee" paddingHorizontal="0" minHeight={0} height={26} hitSlop={10} onPress={() => setAssigneeOpen(!assigneeOpen)}>{h.workItem.assignee ? <WorkAvatar person={h.workItem.assignee} size={26} /> : <Glyph icon={Users} />}</Btn> : null}
            </XStack>
            {h.workItem && assigneeOpen ? <WorkAssigneePicker people={h.people ?? []} onPick={person => {
                setAssigneeOpen(false);
                void monolithPhoneOperation('updateWorkItem', { id: h.workItem!.id, roomId: h.workItem!.roomId, assigneeId: person?.pubkey ?? null });
            }} /> : null}
            {h.objective || openBrief ? (
                <ListItem padding="0" paddingLeft="3" borderLeftWidth={2} borderColor={stone ? "strongStroke" : "needsYou"} backgroundColor="transparent"
                    justifyContent="flex-start" onPress={openBrief} disabled={!openBrief}
                    aria-label="Read the brief" accessibilityRole="button" testID="thread-brief">
                    <YStack gap="1" flex={1} minWidth={0}>
                        {h.objective ? <T v="meta" testID="thread-objective">{h.objective}</T> : null}
                        {openBrief ? <T v="metaStrong" color="needsYou">Read the brief</T> : null}
                    </YStack>
                </ListItem>
            ) : null}
            {h.prLine ? (
                <ListItem padding="0" minHeight={HEIGHT.control} gap="2" justifyContent="flex-start" backgroundColor="transparent"
                    onPress={openPr} aria-label={`Open pull request: ${h.prLine}`} accessibilityRole="button" testID="thread-pr">
                    <Glyph icon={GitPullRequest} size={14} />
                    <T v="meta">{h.prLine}</T>
                </ListItem>
            ) : null}

        </YStack>
    );
}
