import React from 'react';
import { XStack, YStack } from 'tamagui';
import { ChevronRight, FileText } from 'lucide-react-native';
import { Copy, Glyph, HEIGHT } from '@/ui/grammar';

/**
 * A file with no preview: one raised row with a file glyph (or the given
 * thumbnail), the name, a "TYPE · size" line and a chevron when it opens.
 */
export function FileRow({ name, meta, leading, opens, quiet = false, testID }: {
    name: string;
    meta: string;
    leading?: React.ReactNode;
    opens: boolean;
    /** An expired file: the name in the secondary tone. */
    quiet?: boolean;
    testID?: string;
}) {
    return (
        <XStack
            minHeight={HEIGHT.control}
            padding="3"
            gap="3"
            alignItems="center"
            borderRadius="md"
            borderWidth={1}
            borderColor="stroke"
            backgroundColor="raised"
            width="100%"
            minWidth={0}
            testID={testID}
        >
            {leading ?? <Glyph icon={FileText} />}
            <YStack flex={1} minWidth={0}>
                <Copy quiet={quiet} numberOfLines={1}>{name}</Copy>
                <Copy small quiet numberOfLines={1}>{meta}</Copy>
            </YStack>
            {opens ? <Glyph icon={ChevronRight} size={16} /> : null}
        </XStack>
    );
}
