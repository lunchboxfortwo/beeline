import React, { useEffect, useState } from 'react';
import { YStack } from 'tamagui';
import type { WebViewProps } from 'react-native-webview';
/** Reuse the already-shipped native audio-capable WebView; no new native module. */
export function VoicePreviewPlayer({
  source,
  onError,
}: {
  source: string;
  onEnd: () => void;
  onError: () => void;
}) {
  const [Player, setPlayer] = useState<React.ComponentType<WebViewProps> | null>(null);
  useEffect(() => {
    let active = true;
    void import('react-native-webview')
      .then((module) => {
        if (active) setPlayer(() => module.WebView);
      })
      .catch(() => {
        if (active) onError();
      });
    return () => {
      active = false;
    };
  }, []);
  const escaped = source.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return (
    <YStack
      position="absolute"
      width={1}
      height={1}
      opacity={0}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {Player && (
        <Player
          source={{ html: `<!doctype html><audio autoplay src="${escaped}"></audio>` }}
          originWhitelist={['*']}
          javaScriptEnabled={false}
          mediaPlaybackRequiresUserAction={false}
          allowsInlineMediaPlayback
          onError={onError}
          onHttpError={onError}
        />
      )}
    </YStack>
  );
}
