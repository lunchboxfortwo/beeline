import React from 'react';
import { Card, Separator, XStack, YStack } from 'tamagui';
import { Maximize2, X } from 'lucide-react-native';
import { Btn, Copy, Glyph, T } from '@/ui/grammar';

type Decorate = (label: string, control: React.ReactElement) => React.ReactElement;
const plain: Decorate = (_label, control) => control;

/**
 * The desktop right panel's thread view (DesktopRoomInspector): the thread's
 * agent, title and state line, Open in the main pane and close; then the
 * objective with Read the brief. The transcript and composer below are shared.
 */
export function InspectorHeader({ leading, title, meta, onOpenInMain, onClose, decorate = plain }: {
    leading?: React.ReactNode;
    title: string;
    meta: string;
    onOpenInMain: () => void;
    onClose: () => void;
    /** Wraps each control, e.g. a desktop hover title. */
    decorate?: Decorate;
}) {
    return (
        <YStack testID="desktop-work-cockpit-header">
            <XStack paddingHorizontal="3" paddingTop="3" paddingBottom="2" gap="2" alignItems="center">
                {leading}
                <YStack flex={1} minWidth={0}>
                    <Copy strong numberOfLines={2}>{title}</Copy>
                    <Copy small quiet numberOfLines={1}>{meta}</Copy>
                </YStack>
                {decorate('Open in the main pane',
                    <Btn kind="icon" label="Open in the main pane" onPress={onOpenInMain} testID="desktop-work-open-in-main"><Glyph icon={Maximize2} size={16} /></Btn>)}
                {decorate('Close work pane',
                    <Btn kind="icon" label="Close work pane" onPress={onClose} testID="desktop-work-cockpit-close"><Glyph icon={X} /></Btn>)}
            </XStack>
            <Separator borderColor="stroke" />
        </YStack>
    );
}

export function InspectorObjective({ objective, openBrief }: { objective: string; openBrief?: () => void }) {
    return (
        <Card backgroundColor="raised" borderWidth={1} borderColor="stroke" padding="3" margin="4" gap="2">
            <Copy small testID="desktop-work-objective">{objective}</Copy>
            {openBrief ? (
                <Btn kind="quiet" label="Read the brief" onPress={openBrief} alignSelf="flex-start" paddingHorizontal="0" testID="desktop-work-brief">
                    <T v="metaStrong" color="needsYou">Read the brief</T>
                </Btn>
            ) : null}
        </Card>
    );
}
