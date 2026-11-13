import React from 'react';
import { YStack } from 'tamagui';
import { router, useLocalSearchParams } from 'expo-router';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { savePendingBrowserShare, validBrowserShareId } from '@/buzz/pending-browser-share';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { ComputerSessionViewer, type ComputerSessionView } from '@/components/buzz/ComputerSession';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { T } from '@/ui/grammar';

/** Public share links enter through phone authentication before opening the viewer. */
export default function BrowserShare() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const [session, setSession] = React.useState<ComputerSessionView | null>(null);
  const [message, setMessage] = React.useState('Opening shared browser…');
  React.useEffect(() => {
    let active = true;
    setSession(null);
    void (async () => {
      if (!validBrowserShareId(id)) {
        if (active) setMessage('This shared browser link is invalid.');
        return;
      }
      if (!(await loadBuzzIdentity())) {
        await savePendingBrowserShare(id);
        if (active) router.replace('/beeline/onboarding');
        return;
      }
      const { access } = await monolithPhoneOperation('openComputerSession', { id });
      if (active) setSession({ id, access, url: `${getBuzzRuntimeConfig().monolithUrl}/s/${id}/`, title: 'Shared browser', status: 'live' });
    })().catch(() => {
      if (active) setMessage('You do not have access to this shared browser, or the session has ended. Open the card in its chat to check.');
    });
    return () => { active = false; };
  }, [id]);
  return session ? <ComputerSessionViewer session={session} onClose={() => router.replace('/beeline/channels')} /> : <YStack flex={1} justifyContent="center" padding="3" backgroundColor="canvas"><T accessibilityRole="alert">{message}</T></YStack>;
}
