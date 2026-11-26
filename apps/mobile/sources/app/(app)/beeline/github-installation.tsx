import { appErrorCopy } from '@/buzz/app-error-copy';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { Redirect, type Href, useLocalSearchParams } from 'expo-router';
import { Button } from '@/components/buzz/Button';
import { ErrorBanner } from '@/components/buzz/ErrorBanner';
import { Copy, Row, Screen, Section } from '@/ui/grammar';
import { clearPendingGitHubInstallation, completeGitHubInstallationRoute, githubInstallationReturnPath } from '@/auth/github-auth-session';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

/** Redirect first, then acknowledge consumption after the destination is handed off. */
function InstallationReturn({ path }: { path: string }) {
  useEffect(() => { void clearPendingGitHubInstallation().catch(() => undefined); }, [path]);
  return <Redirect href={path as Href} />;
}

/** Keep progress and recoverable errors in Beeline after GitHub's consent page. */
export default function GitHubInstallation() {
  useLatencyRouteFrame('/beeline/github-installation');
  const { installed, error: connectionError } = useLocalSearchParams<{ installed?: string; error?: string }>();
  const [returnPath, setReturnPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recoveryPath, setRecoveryPath] = useState('/beeline/channels');
  useEffect(() => {
    let alive = true;
    setError(null);
    void (async () => {
      try {
        const savedPath = await githubInstallationReturnPath();
        const path = savedPath ?? '/beeline/channels';
        if (alive) setRecoveryPath(path);
        if (Platform.OS !== 'web' && !savedPath) throw new Error('This installation was not started on this device. Return to your chat and install Beeline again.');
        if (Platform.OS !== 'web' && installed === '0' && connectionError) {
          if (alive) setReturnPath(`${path}${path.includes('?') ? '&' : '?'}githubConnectionError=${encodeURIComponent(connectionError)}`);
          return;
        }
        await completeGitHubInstallationRoute(installed, connectionError);
        await monolithPhoneOperation('listGitHubRepositories', { refresh: true });
        if (Platform.OS === 'web') WebBrowser.maybeCompleteAuthSession();
        if (alive) setReturnPath(path);
      } catch (reason) {
        if (alive) setError(appErrorCopy(reason));
      }
    })();
    return () => { alive = false; };
  }, [installed, connectionError]);
  if (returnPath) return <InstallationReturn path={returnPath} />;
  return (
    <Screen
      title={error ? 'GitHub needs another try' : 'Connecting GitHub'}
      headerTestID="github-installation-header"
      testID="github-installation-return"
    >
      {error ? (
        <>
          <Section title="GitHub">
            <Row
              label="Continue connecting GitHub"
              detail="Return to your chat to refresh repositories and finish setup."
              right={
                <Button
                  label="Back to chat"
                  variant="secondary"
                  onPress={() => setReturnPath(recoveryPath)}
                  testID="github-installation-recovery"
                />
              }
              last
            />
          </Section>
          <ErrorBanner inline title={error} testID="github-installation-error" />
        </>
      ) : (
        <Copy quiet>
          Checking your installation and loading the repositories Beeline can work in.
        </Copy>
      )}
    </Screen>
  );
}
