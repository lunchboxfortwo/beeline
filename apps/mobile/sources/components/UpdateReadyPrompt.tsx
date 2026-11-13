import * as React from 'react';
import { YStack } from 'tamagui';
import { Download } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/StyledText';
import { CloseButton } from '@/components/buzz/CloseGlyph';
import { ContentTarget } from '@/components/buzz/IndexRow';
import { useUpdates } from '@/hooks/update-provider';
import { Glyph } from '@/ui/grammar';

/** A root-level affordance that remains visible over every interactive route. */
export const UpdateReadyPrompt = React.memo(function UpdateReadyPrompt() {
    const insets = useSafeAreaInsets();
    const { promptVisible, reloadApp, dismissPrompt } = useUpdates();

    if (!promptVisible) return null;

    return (
        <YStack
            pointerEvents="box-none"
            position="absolute"
            left={16}
            right={16}
            top={insets.top + 12}
            alignItems="center"
            zIndex={2000}
            testID="ota-update-ready-prompt"
        >
            <ContentTarget
                accessibilityRole="button"
                accessibilityLabel="Update ready — tap to restart"
                onPress={() => void reloadApp()}
                width="100%"
                maxWidth={520}
                minHeight={56}
                flexDirection="row"
                alignItems="center"
                gap="2"
                paddingHorizontal="4"
                paddingVertical="2"
                borderRadius="md"
                backgroundColor="raised"
                borderWidth={1}
                borderColor="strongStroke"
                testID="ota-update-restart"
            >
                <Glyph icon={Download} size={20} accent />
                <YStack flex={1} minWidth={0}>
                    <Text v="heading">Update ready</Text>
                    <Text v="meta" color="secondary">Tap to restart</Text>
                </YStack>
                <CloseButton
                    accessibilityLabel="Dismiss update prompt"
                    hitSlop={10}
                    onPress={(event) => {
                        event.stopPropagation();
                        dismissPrompt();
                    }}
                    testID="ota-update-dismiss"
                />
            </ContentTarget>
        </YStack>
    );
});
