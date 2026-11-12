import { Button } from '@/components/buzz/Button';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React from 'react';
import { ScrollView, YStack } from 'tamagui';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { retrieveTempText } from '@/sync/persistence';
import * as Clipboard from 'expo-clipboard';
import { HullDialog } from '@/components/buzz/HullDialog';
import { PageHeader } from '@/components/buzz/PageHeader';
import { SafeBottom, SafeTop, T } from '@/ui/grammar';

type Notice = {
    title: string;
    message?: string;
    exitsScreen?: boolean;
};

export default function TextSelectionScreen() {
  useLatencyRouteFrame('/text-selection', true, true);
    const router = useRouter();
    const { textId } = useLocalSearchParams<{ textId: string }>();
    const [fullText, setFullText] = React.useState('');
    const [loading, setLoading] = React.useState(true);
    const [notice, setNotice] = React.useState<Notice | null>(null);

    const handleCopyAll = React.useCallback(async () => {
        if (!fullText) {
            setNotice({ title: "Error", message: "No text available to copy" });
            return;
        }

        try {
            await Clipboard.setStringAsync(fullText);
            setNotice({ title: "Text copied to clipboard" });
        } catch {
            setNotice({ title: "Error", message: "Failed to copy text to clipboard" });
        }
    }, [fullText]);

    React.useEffect(() => {
        if (!textId) {
            setNotice({
                title: "Error",
                message: "No text provided",
                exitsScreen: true,
            });
            setLoading(false);
            return;
        }

        const content = retrieveTempText(textId);
        if (content) {
            setFullText(content);
        } else {
            setNotice({
                title: "Error",
                message: "Text not found or expired",
                exitsScreen: true,
            });
        }
        setLoading(false);
    }, [textId]);

    const copyDisabled = loading || !fullText;

    const dismissNotice = () => {
        if (notice?.exitsScreen) {
            router.back();
            return;
        }
        setNotice(null);
    };

    return (
        <YStack flex={1} backgroundColor="canvas">
            <SafeTop />
            <PageHeader
                action={
                    <Button
                      accessibilityLabel={'Copy'}
                      accessibilityRole="button"
                      disabled={copyDisabled}
                      onPress={handleCopyAll}
                      testID="text-selection-copy"
                      label=""
                      icon={<T v="code" color={copyDisabled ? 'secondary' : 'ink'}>{'⧉'}</T>}
                      variant="quiet"
                      iconOnly
                    />
                }
                backAccessibilityLabel={"Back"}
                onBack={() => router.back()}
                testID="text-selection-header"
                title={"Select Text"}
            />
            {loading ? (
                <T v="body" color="secondary" marginTop="8" textAlign="center">{"Loading..."}</T>
            ) : (
                <ScrollView
                    flex={1}
                    showsVerticalScrollIndicator
                >
                    <YStack paddingHorizontal="4" paddingTop="4" paddingBottom="4">
                        <T
                            v="code"
                            accessibilityLabel={"Select Text"}
                            userSelect="text"
                            textAlignVertical="top"
                        >
                            {fullText}
                        </T>
                    </YStack>
                    <SafeBottom />
                </ScrollView>
            )}

            <HullDialog
                visible={notice !== null}
                onRequestClose={dismissNotice}
                dismissOnBackdrop={false}
                title={notice?.title ?? ''}
                body={notice?.message}
                testID="text-selection-notice"
                actions={[{ label: "OK", onPress: dismissNotice }]}
            />
        </YStack>
    );
}
