import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useEffect } from 'react';
import { YStack } from 'tamagui';
import { router, useLocalSearchParams } from 'expo-router';
import { useURL } from 'expo-linking';
import { Button } from '@/components/buzz/Button';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { signInWithReviewSecret } from '@/auth/review-sign-in';
import { parseReviewSecret } from '@/buzz/review-link';
import { T } from '@/ui/grammar';

/**
 * The store-reviewer landing route. Both `https://usebeeline.app/review/<secret>`
 * and the association-independent `beeline://review/<secret>` resolve here.
 *
 * Nothing inside the app links here, so the app gains no control and no
 * ordinary user ever sees this screen. It signs the device in as the review
 * identity and hands it to the Room deck; anything the server refuses stays
 * here with a useful error and a route back to the ordinary sign-in screen.
 */
export default function ReviewSignIn() {
  useLatencyRouteFrame('/review/[secret]');
  const { secret: routeSecret } = useLocalSearchParams<{ secret?: string | string[] }>();
  const incomingUrl = useURL();
  const secret = parseReviewSecret(routeSecret) ?? parseReviewSecret(incomingUrl ?? undefined);
  const [failure, setFailure] = React.useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!secret) {
        setFailure('This review link is malformed. Request a fresh link and open it again.');
        return;
      }
      try {
        await signInWithReviewSecret(secret);
        if (!cancelled) router.replace('/beeline/channels');
      } catch {
        if (!cancelled)
          setFailure('This review link is invalid or expired. Request a fresh link and try again.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [secret]);

  return (
    <YStack flex={1} alignItems="center" justifyContent="center" backgroundColor="canvas">
      {failure ? (
        <YStack accessibilityRole="alert" width="100%" maxWidth={440} paddingHorizontal="6" testID="review-sign-in-error">
          <T v="title" textAlign="center">Review sign-in failed</T>
          <T v="body" color="secondary" marginVertical="6" textAlign="center">{failure}</T>
          <Button
            label="Return to sign in"
            onPress={() => router.replace('/beeline/onboarding')}
            variant="secondary"
          />
        </YStack>
      ) : (
        <>
          <SurfaceGlyphLoader compact testID="review-signin-loader" />
          <T v="meta" color="secondary" marginTop="4">signing in…</T>
        </>
      )}
    </YStack>
  );
}
