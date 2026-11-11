import React from 'react';
import { Card, ListItem, XStack, YStack } from 'tamagui';
import { ChevronRight, FileText } from 'lucide-react-native';
import { Btn, Copy, Glyph, HEIGHT } from '@/ui/grammar';

/**
 * An artifact in the transcript (build spec decision 18): its preview, the
 * title, “@author · FORMAT · size”, and one Open that opens the viewer. The
 * preview itself is drawn by `components/buzz/ArtifactCard.tsx`, which owns
 * the byte reads, caching and sandboxes.
 */
export function ArtifactCardFrame({
    title,
    kindLine,
    onOpen,
    preview,
    testID,
}: {
    title: string;
    kindLine: string;
    onOpen(): void;
    preview: React.ReactNode;
    testID?: string;
}) {
    return (
        <Card backgroundColor="raised" borderWidth={1} borderColor="stroke" borderRadius="md" padding="3" gap="3" testID={testID}>
            <YStack borderRadius="md" borderWidth={1} borderColor="stroke" backgroundColor="canvas" overflow="hidden">
                {preview}
            </YStack>
            <YStack gap="1">
                <Copy strong numberOfLines={1} testID="artifact-title">{title}</Copy>
                <Copy small quiet numberOfLines={1} testID="artifact-kind-line">{kindLine}</Copy>
            </YStack>
            <XStack justifyContent="flex-end">
                <Btn kind="secondary" label="Open artifact" accessibilityRole="link" onPress={onOpen} testID="artifact-open">Open</Btn>
            </XStack>
        </Card>
    );
}

/** A file with no preview: one row that opens the viewer. */
export function ArtifactFileRow({
    title,
    kindLine,
    onOpen,
    testID,
}: {
    title: string;
    kindLine: string;
    onOpen(): void;
    testID?: string;
}) {
    return (
        <ListItem
            padding="3"
            gap="3"
            minHeight={HEIGHT.control}
            borderRadius="md"
            borderWidth={1}
            borderColor="stroke"
            backgroundColor="raised"
            onPress={onOpen}
            accessibilityRole="button"
            aria-label={`Open ${title}`}
            testID={testID}
        >
            <Glyph icon={FileText} />
            <YStack flex={1} minWidth={0}>
                <Copy numberOfLines={1} testID="artifact-title">{title}</Copy>
                <Copy small quiet numberOfLines={1} testID="artifact-kind-line">{kindLine}</Copy>
            </YStack>
            <Glyph icon={ChevronRight} size={16} />
        </ListItem>
    );
}
