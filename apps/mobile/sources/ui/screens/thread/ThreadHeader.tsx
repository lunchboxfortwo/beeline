import { RepositoryMark } from '@/components/buzz/RepositoryMark';
import React from 'react';
import type { View } from 'react-native';
import { ListItem, XStack, YStack } from 'tamagui';
import { ArrowLeft, CornerDownRight, GitPullRequest, MoreHorizontal } from 'lucide-react-native';
import type { CornerState } from '@beeline/api-contract/phone';
import { Btn, Glyph, HEIGHT, SafeTop, T } from '@/ui/grammar';
import { threadDotTone, threadStatusText } from './thread-status';

/**
 * Header B (the only thread header). A slim bar keeps Back, the chat (opens
 * it) and ⋯; the title, status, pull request and objective are the first
 * block of the transcript. Once that block scrolls away, the bar takes the
 * title with a status dot. A small scroll up, or a tap on that title, shows
 * the full header under the bar until the reader scrolls down.
 * There is no driver line.
 */
export type ThreadHeaderData = {
    /** `#beeline`, or null while the parent's name has not landed. */
    chatTag: string | null;
    title: string;
    repositoryAvatar?: string;
    repositoryFavicon?: string;
    /** Undefined until the parent Room's corner row lands. */
    state?: CornerState;
    running: number;
    prLine?: string;
    objective?: string;
};

export function StatusDot({ state }: { state: CornerState }) {
    const tone = threadDotTone(state);
    return <YStack width={8} height={8} borderRadius="full" backgroundColor={tone === 'needsYou' ? 'needsYou' : tone === 'added' ? 'added' : 'strongStroke'} testID="thread-status-dot" />;
}

export function ThreadBar({ h, collapsed, expanded, back, openChat, expand, openActions, safeTop = true, barRef, onBarLayout }: {
    h: ThreadHeaderData; collapsed: boolean;
    /** The full header, shown under the bar while the title block is away. */
    expanded?: React.ReactNode;
    back?: () => void; openChat: () => void;
    expand?: () => void; openActions?: () => void; safeTop?: boolean;
    barRef?: React.Ref<View>; onBarLayout?: () => void;
}) {
    return (
        <YStack backgroundColor="raised" borderBottomWidth={1} borderColor="stroke" testID="corner-session-header">
            <YStack ref={barRef as never} onLayout={onBarLayout}>
                {safeTop ? <SafeTop /> : null}
                <XStack paddingHorizontal="2" paddingVertical="1" gap="2" alignItems="center" testID="thread-header">
                    {back ? <Btn kind="icon" label="Back" onPress={back} testID="chat-back"><Glyph icon={ArrowLeft} /></Btn> : null}
                    <XStack flex={1} minWidth={0} gap="2" alignItems="center">
                        {h.repositoryAvatar || h.repositoryFavicon ? <RepositoryMark avatarUrl={h.repositoryAvatar} faviconUrl={h.repositoryFavicon} size={28} /> : null}
                        {/* The chat and the title stack, so each wraps across the bar's full width and neither starves the other. */}
                        <YStack flex={1} minWidth={0} justifyContent="center" minHeight={HEIGHT.control} testID="thread-bar-names">
                            {h.chatTag ? (
                                <ListItem padding="0" minHeight={0} alignSelf="flex-start" width="auto" maxWidth="100%"
                                    backgroundColor="transparent" justifyContent="flex-start" onPress={openChat}
                                    aria-label={`Open chat ${h.chatTag}`} accessibilityRole="button" testID="thread-chat-link">
                                    <T v="metaStrong" color="needsYou" flexShrink={1}>{h.chatTag}</T>
                                </ListItem>
                            ) : null}
                            {collapsed && !expanded ? (
                                <ListItem padding="0" minHeight={0} gap="2" alignItems="center"
                                    backgroundColor="transparent" justifyContent="flex-start" onPress={expand}
                                    aria-label={h.title} accessibilityRole={expand ? 'button' : 'text'} testID="thread-bar-title">
                                    {h.state ? <StatusDot state={h.state} /> : null}
                                    <T v="metaStrong" flexShrink={1}>{h.title}</T>
                                </ListItem>
                            ) : null}
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

/** The transcript's first (oldest) block: ↳ title, status, PR row, objective and "Read the brief". */
export function ThreadTitleBlock({ h, openBrief, openPr, blockRef, onBlockLayout }: {
    h: ThreadHeaderData; openBrief?: () => void; openPr?: () => void;
    blockRef?: React.Ref<View>; onBlockLayout?: () => void;
}) {
    return (
        <YStack ref={blockRef as never} onLayout={onBlockLayout} width="100%" maxWidth={720} alignSelf="center"
            paddingHorizontal="4" paddingTop="4" paddingBottom="3" gap="3" borderBottomWidth={1} borderColor="stroke"
            testID="thread-title-block">
            <XStack gap="2" alignItems="flex-start">
                <YStack paddingTop="1"><Glyph icon={CornerDownRight} accent /></YStack>
                <YStack flex={1} minWidth={0}><T v="title" testID="thread-title">{h.title}</T></YStack>
            </XStack>
            {h.state ? (
                <XStack gap="2" alignItems="center" testID="thread-status">
                    <StatusDot state={h.state} />
                    <T v="metaStrong" color={threadDotTone(h.state) === 'needsYou' ? 'needsYou' : 'secondary'}>
                        {threadStatusText(h.state, h.running)}
                    </T>
                </XStack>
            ) : null}
            {h.prLine ? (
                <ListItem padding="0" minHeight={HEIGHT.control} gap="2" justifyContent="flex-start" backgroundColor="transparent"
                    onPress={openPr} aria-label={`Open pull request: ${h.prLine}`} accessibilityRole="button" testID="thread-pr">
                    <Glyph icon={GitPullRequest} size={14} />
                    <T v="meta">{h.prLine}</T>
                </ListItem>
            ) : null}
            {h.objective || openBrief ? (
                <ListItem padding="0" paddingLeft="3" borderLeftWidth={2} borderColor="needsYou" backgroundColor="transparent"
                    justifyContent="flex-start" onPress={openBrief} disabled={!openBrief}
                    aria-label="Read the brief" accessibilityRole="button" testID="thread-brief">
                    <YStack gap="1" flex={1} minWidth={0}>
                        {h.objective ? <T v="body" numberOfLines={3} testID="thread-objective">{h.objective}</T> : null}
                        {openBrief ? <T v="metaStrong" color="needsYou">Read the brief</T> : null}
                    </YStack>
                </ListItem>
            ) : null}
        </YStack>
    );
}
