import { appErrorCopy } from '@/buzz/app-error-copy';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { Spinner, YStack } from 'tamagui';
import * as WebBrowser from 'expo-web-browser';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSandboxWebView } from '@/components/buzz/sandbox-webview';
import { useInstallObserver } from '@/buzz/use-observed-resource';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { connectorOfferCompletionRoute } from '@/buzz/connector-offer-ceremony';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { takeAppSignInReturn } from '@/buzz/app-sign-in';
import { Btn, Copy, T } from '@/ui/grammar';
import { ConnectorFooter, ConnectorFrame, ConnectorNote } from '@/ui/screens/settings/connectors/ConnectorParts';

function first(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }

/** The provider returns a one-use verifier session; only the server can settle it. */
export default function ConnectorSignInScreen() {
  useLatencyRouteFrame('/beeline/settings/workbench/connect-signin');
  const params = useLocalSearchParams<{ appSignInSession?: string | string[] }>();
  const sessionUri = first(params.appSignInSession);
  return sessionUri ? (
    <AppSignInReturnScreen sessionUri={sessionUri} /> ) : (
    <ConnectorSignInOverlay />);
}

function AppSignInReturnScreen({ sessionUri }: { sessionUri: string }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void takeAppSignInReturn().then(async (destination ) => {
      if (!destination?.appId) throw new Error('App sign-in could not be matched to a connection');
      await getWorkbenchSource().completeAppSignIn({ sessionUri, appId: destination.appId });
      if (!live) return;
      router.replace(destination?.roomId ? (connectorOfferCompletionRoute(destination.roomId) as Href )
            : ({ pathname: '/beeline/settings/workbench', params: { workspaceId: destination?.workspaceId ?? '', viewerId: destination?.viewerId ?? '' } } as Href),
        );
    }).catch(cause => { if (live) setError(appErrorCopy(cause, 'Sign-in could not be verified')); });
    return () => { live = false; };
  }, [sessionUri]);
  return (
    <YStack flex={1} alignItems="center" justifyContent="center" padding="6" backgroundColor="canvas" testID="app-sign-in-return">
      {error ? <ConnectorNote tone="danger" testID="app-sign-in-error">{error}</ConnectorNote>
        : <Spinner color="secondary" accessibilityLabel="Completing app sign-in" />}
    </YStack>);
}

/** Existing Trusty Squire helper sign-in retains its streamed browser overlay. */
function ConnectorSignInOverlay() {
  const params = useLocalSearchParams<{
    workspaceId?: string | string[]; viewerId?: string | string[];
    connectorId?: string | string[]; connectorName?: string | string[];
    roomId?: string | string[]; offerId?: string | string[]; url?: string | string[]; method?: string | string[];
    machineName?: string | string[];
  }>();
  const workspaceId = first(params.workspaceId) ?? '';
  const viewerId = first(params.viewerId) ?? '';
  const connectorId = first(params.connectorId) ?? '';
  const connectorName = first(params.connectorName) ?? 'App';
  const roomId = first(params.roomId);
  const machineName = first(params.machineName) ?? 'your computer';
  const [signIn, setSignIn] = useState({ url: first(params.url) ?? '', method: first(params.method) ?? 'streamed' });
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageLoaded, setPageLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [fallback, setFallback] = useState(false);
  const WebView = useSandboxWebView();

  const observed = useInstallObserver(workspaceId, connectorId);
  const squire = connectorId.startsWith('squire:') || connectorName === 'Trusty Squire';
  const external = signIn.method === 'oauth' || Platform.OS === 'web';
  // A finished Squire sign-in lands on the Trusty Squire page, where the row now reads signed in.
  const finish = useCallback(() => router.replace(roomId ? (connectorOfferCompletionRoute(roomId) as Href )
          : squire ? ({ pathname: '/beeline/settings/workbench/service', params: { workspaceId, viewerId, service: 'trusty-squire' } } as Href)
            : ({ pathname: '/beeline/settings/workbench', params: { workspaceId, viewerId } } as Href),
      ), [roomId, squire, viewerId, workspaceId],
  );
  // Android reports a failed load as finished too; only a clean finish counts.
  const loadFailed = useRef(false);
  const pageFailed = useCallback(() => {
    loadFailed.current = true;
    setPageLoaded(false);
    setPageError(PAGE_LOAD_ERROR);
  }, []);
  const retry = useCallback(async () => {
    loadFailed.current = false;
    setFallback(false);
    setPageLoaded(false);
    setAttempt(value => value + 1);
    setPageError(null);
    try {
      if (observed.data?.steps.some(step => step.status === 'failed')) {
        setSignIn(current => ({ ...current, url: '' }));
        const offerId = first(params.offerId);
        if (offerId) await monolithPhoneOperation('acceptConnectorOffer', { offerId });
        else if (connectorId.startsWith('squire:')) await getWorkbenchSource().pairConnector({
          workspaceId, connectorId: 'trusty-squire', helperId: connectorId.slice(7) });
      }
      await observed.retry();
    } catch { setPageError('Google sign-in could not restart. Try again.'); }
  }, [observed.retry, observed.data, params.offerId, connectorId, workspaceId]);
  useEffect(() => {
    const state = observed.data;
    if (!state) return;
    if (state.connected) { finish(); return; }
    if (state.signIn) setSignIn(current => current.url === state.signIn!.url ? current : { url: state.signIn!.url, method: state.signIn!.method });
    else if (state.steps?.some(step => step.status === 'failed')) {
      setSignIn(current => ({ ...current, url: '' }));
      setPageError(state.steps.find(step => step.status === 'failed')?.reason
        ?? `Sign-in could not start on ${machineName}. Try again.`);
    }
  }, [observed.data, finish, machineName]);

  const openBrowser = useCallback(async () => {
    if (!signIn.url) return;
    setPageError(null);
    setFallback(true);
    try {
      await WebBrowser.openBrowserAsync(signIn.url);
      void observed.retry();
    } catch { setPageError('Google sign-in could not open. Try again.'); }
  }, [signIn.url, observed.retry]);
  useEffect(() => {
    if (!fallback) return;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void observed.retry();
    });
    return () => subscription.remove();
  }, [fallback, observed.retry]);

  const failure = observed.error || pageError;
  const errorLine = failure === PAGE_LOAD_ERROR
    ? `${machineName}’s browser didn’t answer within 15 seconds. Try again, or finish sign-in in your phone’s browser.`
    : failure;
  const streamed = !external;
  const loading = !failure && !fallback && (!signIn.url || (streamed && !pageLoaded));
  return (
    <ConnectorFrame title={squire ? 'Sign in to Google' : `Sign in to ${connectorName}`} back={() => router.back()}
      backLabel="Close sign-in" testID="signin-overlay" scroll={false}
      footer={failure ? <ConnectorFooter>
        <Btn kind="primary" label={observed.installMissing ? 'Go back' : 'Try again'}
          onPress={observed.installMissing ? () => router.back() : () => void retry()} testID="signin-retry">{observed.installMissing ? 'Go back' : 'Try again'}</Btn>
        {!observed.installMissing && signIn.url
          ? <Btn label="Open in browser" onPress={() => void openBrowser()} testID="signin-open-external">Open in browser</Btn> : null}
      </ConnectorFooter> : loading && signIn.url ? <ConnectorFooter>
        <Btn label="Open in browser instead" onPress={() => void openBrowser()} testID="signin-open-external">Open in browser instead</Btn>
      </ConnectorFooter> : undefined}>
      <YStack flex={1} minHeight={0} testID="signin-card">
        {streamed && !failure && !fallback && WebView && signIn.url ? (
          <YStack flex={1} opacity={pageLoaded ? 1 : 0}>
            {React.createElement(WebView, { key: `${signIn.url}:${attempt}`, onLoad: () => { if (!loadFailed.current) setPageLoaded(true); }, onError: pageFailed, onHttpError: pageFailed, renderError: () => null, source: { uri: signIn.url }, style: WEBVIEW_FILL, javaScriptEnabled: true, domStorageEnabled: true, testID: 'signin-webview' })}
          </YStack>
        ) : null}
        {!streamed && !failure && signIn.url ? (
          <SignInCenter testID="signin-oauth-browser">
            <Copy small quiet textAlign="center">{connectorName} sign-in opens in your browser. Return here after granting access.</Copy>
            <Btn kind="primary" label={`Continue with ${connectorName}`} onPress={() => void openBrowser()} testID="signin-open-external">{`Continue with ${connectorName}`}</Btn>
          </SignInCenter>
        ) : failure ? (
          <SignInCenter testID="signin-error">
            <T v="heading" textAlign="center">{squire ? 'Google sign-in didn’t load' : `${connectorName} sign-in didn’t load`}</T>
            <ConnectorNote tone="danger" testID="signin-error-line">{errorLine ?? ''}</ConnectorNote>
          </SignInCenter>
        ) : fallback ? (
          <SignInCenter testID="signin-finishing">
            <Spinner color="needsYou" accessibilityLabel="Finishing sign-in" />
            <T v="body" textAlign="center">Finishing sign-in…</T>
            <Copy small quiet textAlign="center">You signed in on Chrome. {machineName} is saving the session. This page switches to connected by itself.</Copy>
          </SignInCenter>
        ) : loading ? (
          <SignInCenter cover testID="signin-webview-loading">
            <Spinner color="needsYou" accessibilityLabel="Loading Google sign-in" />
            <T v="body" textAlign="center">{squire ? 'Loading Google sign-in…' : `Loading ${connectorName} sign-in…`}</T>
            <Copy small quiet textAlign="center">From {machineName}’s secure browser</Copy>
          </SignInCenter>
        ) : null}
      </YStack>
    </ConnectorFrame>
  );
}

/** The streamed page fills the body. */
const WEBVIEW_FILL = { flex: 1 };

/** One centred state in the body; `cover` lays it over the still-hidden page. */
function SignInCenter({ children, cover = false, testID }: { children: React.ReactNode; cover?: boolean; testID?: string }) {
  return (
    <YStack flex={1} alignItems="center" justifyContent="center" gap="3" paddingHorizontal="6" backgroundColor="canvas" testID={testID}
      {...(cover ? { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const : {})}>
      {children}
    </YStack>
  );
}

/** A page that fails while its name is new reloads itself inside the 15 seconds. */
const PAGE_LOAD_ERROR = 'The sign-in page did not load.';
