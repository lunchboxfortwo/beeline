import React from 'react';
import { ListItem, ScrollView, Separator, Spinner, XStack, YStack } from 'tamagui';
import { ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react-native';
import { Btn, Glyph, HEIGHT, SafeBottom, SafeTop, T } from '@/ui/grammar';
import { Rise } from './Rise';

/**
 * The onboarding chrome (build spec decision 29): one 4-segment progress
 * rail, large choice cards, a 52 px primary action and the rise-in motion.
 * On desktop the column is centred, at most 480 wide, with no sidebar.
 */
const STAGES = ['Sign in', 'You', 'Workspace', 'Invite'] as const;
export type Stage = 0 | 1 | 2 | 3;

/** Four segments; brass up to and including the current stage. */
export function Rail({ at }: { at: Stage }) {
    return (
        <XStack gap="1" flex={1} aria-label={`Step ${at + 1} of ${STAGES.length}: ${STAGES[at]}`} testID="onboarding-rail">
            {STAGES.map((stage, index) => (
                <YStack key={stage} flex={1} height={3} borderRadius="full" backgroundColor={index <= at ? 'needsYou' : 'stroke'} testID={index <= at ? 'rail-done' : 'rail-todo'} />
            ))}
        </XStack>
    );
}

/** The one primary action of a step, 52 px tall. */
export function Primary({ label, onPress, disabled, busy, testID }: {
    label: string; onPress: () => void; disabled?: boolean; busy?: boolean; testID?: string;
}) {
    return (
        <Btn kind="primary" label={label} minHeight={HEIGHT.tabBar} borderRadius="lg" disabled={disabled || busy} onPress={onPress} testID={testID}>
            {busy ? <Spinner color="primaryInk" /> : label}
        </Btn>
    );
}

/** A large choice: one glyph, a title, one line. Brass only on the recommended path or the current choice. */
export function Choice({ icon, title, line, onPress, accent = false, expanded, testID }: {
    icon: React.ComponentProps<typeof Glyph>['icon']; title: string; line: string; onPress: () => void;
    accent?: boolean; expanded?: boolean; testID: string;
}) {
    return (
        <ListItem
            padding="4" gap="3" borderRadius="lg" borderWidth={1} borderColor={accent ? 'needsYou' : 'strongStroke'}
            backgroundColor="raised" alignItems="flex-start" justifyContent="flex-start" onPress={onPress}
            aria-label={title} accessibilityRole="button"
            accessibilityState={expanded === undefined ? undefined : { expanded }} testID={testID}
        >
            <YStack width={40} height={40} borderRadius="md" backgroundColor="highlight" alignItems="center" justifyContent="center">
                <Glyph icon={icon} size={20} accent={accent} />
            </YStack>
            <YStack flex={1} minWidth={0} gap="1">
                <T v="heading">{title}</T>
                <T v="meta" color="secondary">{line}</T>
            </YStack>
            <YStack paddingTop="2"><Glyph icon={expanded ? ChevronDown : ChevronRight} size={16} /></YStack>
        </ListItem>
    );
}

/** A step's title and its optional line. */
export function Heading({ title, line }: { title: string; line?: string }) {
    return (
        <Rise>
            <YStack gap="2">
                <T v="title" accessibilityRole="header">{title}</T>
                {line ? <T v="body" color="secondary">{line}</T> : null}
            </YStack>
        </Rise>
    );
}

/** The "or" rule between an invite and the other way in. */
export function OrRule() {
    return (
        <XStack alignItems="center" gap="3">
            <Separator flex={1} borderColor="stroke" />
            <T v="meta" color="secondary">or</T>
            <Separator flex={1} borderColor="stroke" />
        </XStack>
    );
}

/** A refusal or failure line under the step's content. */
export function Problem({ title, message, testID }: { title?: string; message: string; testID?: string }) {
    return (
        <YStack gap="1" testID={testID}>
            {title ? <T v="metaStrong" color="removed">{title}</T> : null}
            <T v="meta" color={title ? 'secondary' : 'removed'}>{message}</T>
        </YStack>
    );
}

/**
 * One onboarding step: Back and the rail on top (none on the welcome),
 * the step's content, and its primary action pinned at the bottom.
 * `center` stands the content in the middle (the welcome mark).
 */
export function OnboardingFrame({ stage, back, footer, center = false, testID, children }: {
    stage?: Stage; back?: () => void; footer?: React.ReactNode; center?: boolean; testID?: string; children: React.ReactNode;
}) {
    return (
        <YStack flex={1} minHeight={0} backgroundColor="canvas" testID={testID}>
            <SafeTop />
            <YStack flex={1} minHeight={0} width="100%" maxWidth={480} alignSelf="center" paddingHorizontal="5" paddingTop="3" paddingBottom="5" gap="5">
                {stage === undefined ? null : (
                    <XStack alignItems="center" gap="3" height={HEIGHT.control}>
                        {back ? <Btn kind="icon" label="Back" onPress={back} testID="onboarding-back"><Glyph icon={ArrowLeft} /></Btn> : <YStack width={HEIGHT.control} />}
                        <Rail at={stage} />
                        <YStack width={HEIGHT.control} />
                    </XStack>
                )}
                {center
                    ? <YStack flex={1} minHeight={0} alignItems="center" justifyContent="center" gap="4">{children}</YStack>
                    : (
                        <ScrollView flex={1} minHeight={0} keyboardShouldPersistTaps="handled">
                            <YStack gap="5" paddingBottom="4">{children}</YStack>
                        </ScrollView>
                    )}
                {footer ? <Rise order={2}><YStack gap="3">{footer}</YStack></Rise> : null}
            </YStack>
            <SafeBottom />
        </YStack>
    );
}
