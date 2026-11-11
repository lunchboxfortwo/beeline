import { authPhase, observeAuth, authFailureCode } from '@/auth/auth-diagnostics';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { beginFunnelAttempt, pendingFunnelAttempt, funnelScreen, funnelCallback } from '@/auth/signin-funnel';
import { useRepositoryOnboarding } from '@/buzz/onboarding-rollout';
import { clearPendingGoogleSignIn, resumeGoogleSignIn, runGoogleSignIn } from '@/auth/google-auth-session';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { useTextDraft } from '@/buzz/use-text-draft';
/** Native GitHub-first onboarding. OAuth proves lookup only; the Nostr key remains device-held. */
import React, { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { Input, Spinner, XStack, YStack } from 'tamagui';
import { Btn, HEIGHT, T } from '@/ui/grammar';
import { Heading, OnboardingFrame, Primary, Problem } from '@/ui/screens/onboarding/OnboardingFrame';
import { Rise } from '@/ui/screens/onboarding/Rise';
import { router } from 'expo-router';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { getRandomBytes } from 'expo-crypto';
import {
  lookupManagedIdentity,
  normalizeManagedHandle,
  OidcBindError,
  type BuzzClient,
  buildOidcBindEvent,
  finishOidcBind,
  recoverOidcBind,
  type Identity,
  type ManagedIdentity,
  type OidcBindChallenge,
} from '@beeline/buzz-client';
import {
  clearPendingGitHubIdentity,
  loadBuzzIdentity,
  loadPendingGitHubIdentity,
} from '@/auth/buzz-identity-storage';
import {
  clearOnboardingNotice,
  isSignInInFlight,
  beginSignInAttempt,
  finishSignInAttempt,
  nextOnboardingStatus,
  noticeForAuthError,
  publishOnboardingNotice,
  subscribeToOnboardingNotices,
  type OnboardingNotice,
  type OnboardingStatus,
} from '@/auth/onboarding-state';
import { authSessionOptions } from '@/auth/auth-session';
import {
  clearPendingGitHubSignInState,
  cancelPendingGitHubSignIn,
  isGitHubSignInLeft,
  isPendingGitHubReconnect,
  loadPendingGitHubBindChallenge,
  recoverPendingGitHubBindChallenge,
  resumeInitialGitHubSignIn,
  runResilientGitHubSignInSession,
} from '@/auth/github-auth-session';
import {
  clearPersonNameOnboardingPending,
  loadPreferredPersonName,
  markPersonNameOnboardingPending,
  resolveOnboardingPersonName,
  savePreferredPersonName,
} from '@/buzz/person-name';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { BeelineMark } from '@/components/buzz/BeelineMark';
import { registerBuzzPushNotifications } from '@/push/buzz-push-registration';
import { BuzzRigTransport } from '@/sync/transport';
import { GitHubAccountMismatchError, monolithSession } from '@/auth/monolith-session';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { isTauri } from '@/utils/isTauri';
import { accountSignInAvailable } from '@/auth/account-sign-in-platform';
import {
  initialAuthUrl,
  openAccountAuthSession,
  subscribeToAuthUrls,
} from '@/auth/desktop-auth-session';

WebBrowser.maybeCompleteAuthSession();

interface PendingBind {
  challenge: OidcBindChallenge;
  identity: Identity;
  bound: boolean;
  managedIdentity?: ManagedIdentity;
}

async function exchangeFunnelTicket(ticket:string, provider: 'github' | 'google' = 'github'){
  const context=await pendingFunnelAttempt().catch(()=>undefined);
  if (provider === 'google') {
    return context
      ? monolithSession.exchangeGoogleTicket(ticket, context)
      : monolithSession.exchangeGoogleTicket(ticket);
  }
  return context
    ? monolithSession.exchangeGitHubTicket(ticket, context)
    : monolithSession.exchangeGitHubTicket(ticket);
}

function randomState(): string {
  return btoa(String.fromCharCode(...getRandomBytes(32)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

const WEB_NOTICE: OnboardingNotice = {
  status: 'idle',
  title: 'NATIVE ONLY',
  message:
    'Account sign-in is available in the Android and iOS app. Web key storage is not hardened for this flow.',
  retryable: false,
};

export default function BuzzOnboarding() {
  const repositoryOnboarding = useRepositoryOnboarding();
  useEffect(() => { void funnelScreen().catch(()=>undefined); }, []);
  useLatencyRouteFrame('/beeline/onboarding', true, true);
  const pendingBind = useRef<PendingBind | null>(null);
  const existingIdentity = useRef<Identity | null>(null);
  const canSignIn = accountSignInAvailable(Platform.OS, isTauri());
  const [status, setStatus] = useState<OnboardingStatus>('checking_device');
  const [notice, setNotice] = useState<OnboardingNotice | null>(canSignIn ? null : WEB_NOTICE);
  const [loadingAction, setLoadingAction] = useState<
    'google' | 'github' | 'bind' | 'recover' | 'name' | null
  >(null);
  const [namingIdentity, setNamingIdentity] = useState<Identity | null>(null);
  const [namingClient, setNamingClient] = useState<BuzzClient | null>(null);
  const [nameInput, setNameInput, onboardingNameDraft] = useTextDraft('onboarding:name',
    '',
    namingIdentity?.publicKey ?? null,
  );
  const loading = loadingAction !== null;

  const enterAfterMonolithSignIn = async (_identityId: string | undefined) => {
    // Repository discovery belongs to the in-app picker. An unavailable
    // GitHub service must never hold a successfully signed-in user here.
    await authPhase('navigation_started', async () => { router.replace('/beeline/channels'); });
  };

  const restorePendingBind = async (): Promise<boolean> => {
    const [challenge, identity] = await Promise.all([
      loadPendingGitHubBindChallenge(),
      loadBuzzIdentity().then(async (saved) => saved ?? (await loadPendingGitHubIdentity())),
    ]);
    if (!challenge || !identity) return false;
    existingIdentity.current = identity;
    pendingBind.current = { challenge, identity, bound: false };
    return true;
  };

  useEffect(
    () =>
      subscribeToOnboardingNotices((next) => {
        if (next.status === 'link_conflict' && !pendingBind.current) {
          void restorePendingBind()
            .then((restored) => {
              if (restored) {
                setStatus(next.status);
                setNotice(next);
                return;
              }
              const expired = noticeForAuthError(
                new OidcBindError(
                  'ticket_expired',
                  'The replacement proof is no longer available. Sign in again.',
                  410,
                ),
                'github',
              );
              setStatus(expired.status);
              setNotice(expired);
            })
            .catch((error: unknown) => {
              const failed = noticeForAuthError(error, 'github');
              setStatus(failed.status);
              setNotice(failed);
            });
          return;
        }
        setStatus(next.status);
        setNotice(next);
      }),
    [],
  );

  const continueAfterIdentity = async (
    identity: Identity,
    suppliedManagedIdentity?: ManagedIdentity,
    requireManagedHandle = false,
  ) => {
    setStatus('entering_workspace');
    try {
      const transport = new BuzzRigTransport(identity);
      const client = await transport.ensureClient();
      const enterWithManagedIdentity = async (managedIdentity: ManagedIdentity) => {
        let displayName = managedIdentity.displayName;
        try {
          const current = await client.getGlobalPersonProfile(identity.publicKey).catch(() => null);
          displayName = current?.name ?? managedIdentity.displayName;
          await client.setGlobalPersonProfile({
            name: displayName,
            handle: managedIdentity.handle,
            avatar: current?.avatar,
          });
        } catch {
          // The server-side assignment is already authoritative. Profile
          // publication can retry after entry; GitHub users are never sent to
          // a redundant naming prompt because relay projection is delayed.
        }
        await savePreferredPersonName(identity.publicKey, displayName).catch(() => undefined);
        await clearPersonNameOnboardingPending().catch(() => undefined);
        router.replace('/beeline/channels');
      };
      const managedIdentity =
        suppliedManagedIdentity ??
        (await lookupManagedIdentity(getBuzzRuntimeConfig().relayUrl, identity).catch(() => null));
      if (managedIdentity) {
        await enterWithManagedIdentity(managedIdentity);
        return;
      }
      if (!requireManagedHandle) {
        const resolved = await resolveOnboardingPersonName(client, identity.publicKey);
        if (!resolved.needsPrompt) {
          await clearPersonNameOnboardingPending();
          router.replace('/beeline/channels');
          return;
        }
      }
      setNamingClient(client);
      setNamingIdentity(identity);
      setNotice(null);
    } catch {
      if (!requireManagedHandle) {
        const preferred = await loadPreferredPersonName(identity.publicKey);
        if (preferred) {
          await clearPersonNameOnboardingPending();
          router.replace('/beeline/channels');
          return;
        }
      }
      setNamingClient(null);
      setNamingIdentity(identity);
      setNotice(null);
    }
  };

  const finishPendingBind = async (pending: PendingBind) => {
    setLoadingAction('bind');
    setStatus('binding');
    clearOnboardingNotice();
    setNotice(null);
    try {
      if (!pending.bound) {
        if (pending.challenge.expires_at <= Math.floor(Date.now() / 1_000)) {
          throw new OidcBindError('ticket_expired', 'The bind ticket expired', 410);
        }
        const event = buildOidcBindEvent(pending.challenge, pending.identity);
        const result = await finishOidcBind(
          getBuzzRuntimeConfig().relayUrl,
          pending.challenge,
          event,
        );
        pending.managedIdentity = result.identity;
        pending.bound = true;
      }
      await clearPendingGitHubSignInState();
      // GitHub OAuth establishes the identity. Repository installation is a
      // separate, user-triggered action in the workspace and Room repo pickers.
      // Everything after the bind is recoverable in-app. Never report a false
      // sign-in failure after the durable identity is present.
      await clearPendingGitHubIdentity().catch(() => undefined);
      await markPersonNameOnboardingPending().catch(() => undefined);
      // Push registration is recoverable in-app. Once the key is saved, never
      // turn optional setup work into a false sign-in failure.
      await registerBuzzPushNotifications(pending.identity).catch(() => undefined);
      pendingBind.current = null;
      setStatus(nextOnboardingStatus('binding', 'bind_succeeded'));
      await continueAfterIdentity(pending.identity, pending.managedIdentity);
    } catch (error) {
      const normalized =
        error instanceof OidcBindError
          ? error
          : new OidcBindError(
              'storage_failed',
              appErrorCopy(error),
              500,
            );
      const next = noticeForAuthError(normalized, 'github');
      if (!next.retryable && normalized.code !== 'identity_conflict') pendingBind.current = null;
      setStatus(next.status);
      setNotice(next);
      publishOnboardingNotice(next);
    } finally {
      setLoadingAction(null);
    }
  };

  useEffect(() => {
    if (!canSignIn) {
      setStatus('idle');
      return;
    }
    let alive = true;
    let recoveryProvider: 'google' | 'github' = 'google';
    void (async () => {
      const initialUrl = await initialAuthUrl().catch(() => null);
      // A press already running in this process owns its own callback. This
      // screen is the one expo-router routed over it when that callback
      // arrived: it must neither spend the one-use ticket a second time nor
      // race the press while it completes sign-in.
      if (isSignInInFlight()) return;
      const savedIdentityId = await monolithSession.identityId();
      if (savedIdentityId && !(await isPendingGitHubReconnect())) {
        // A process can stop after saving its session but before removing the
        // one-use OAuth continuation. The saved session wins on the next boot.
        if (alive) await enterAfterMonolithSignIn(savedIdentityId);
        return;
      }
      const googleTicket = await resumeGoogleSignIn(initialUrl);
      if (googleTicket) {
        void funnelCallback('success');
        const identityId = await exchangeFunnelTicket(googleTicket, 'google');
        await clearPendingGoogleSignIn().catch(() => undefined);
        if (alive) await enterAfterMonolithSignIn(identityId);
        return;
      }
      recoveryProvider = 'github';
      const challenge =
        (await resumeInitialGitHubSignIn(() => Promise.resolve(initialUrl), undefined, {
          signedIn: savedIdentityId !== null,
        })) ??
        (await recoverPendingGitHubBindChallenge()) ??
        (await loadPendingGitHubBindChallenge());
      if (challenge) {
        if (await isPendingGitHubReconnect()) {
          let result = 'success';
          try {
            await monolithSession.reconnectGitHubTicket(challenge.ticket);
          } catch (error) {
            result = error instanceof GitHubAccountMismatchError ? 'mismatch' : 'failed';
          }
          await clearPendingGitHubSignInState();
          if (alive)
            router.replace({
              pathname: '/beeline/settings',
              params: { githubReconnect: result },
            });
          return;
        }
        void funnelCallback('success');
        if (repositoryOnboarding) setStatus('binding');
        const identityId = await exchangeFunnelTicket(challenge.ticket);
        await clearPendingGitHubSignInState().catch(() => undefined);
        if (alive) await enterAfterMonolithSignIn(identityId);
        return;
      }
      if (savedIdentityId) {
        if (alive) router.replace('/beeline/channels');
      }
    })()
      .catch((error: unknown) => {
        observeAuth({ name: 'auth_failed', phase: 'recovery_started', code: authFailureCode(error,'recovery_started'), outcome: 'failed' });
        if (!alive) return;
        const next = noticeForAuthError(error, recoveryProvider);
        setNotice(next);
        setStatus(next.status);
      })
      .finally(() => {
        if (alive) setStatus((current) => (current === 'checking_device' ? 'idle' : current));
      });
    return () => {
      alive = false;
    };
  }, [canSignIn]);

  const handleGoogleSignIn = async () => {
    if (!canSignIn) return;
    setLoadingAction('google');
    setStatus('opening_browser');
    clearOnboardingNotice();
    setNotice(null);
    const attempt = beginSignInAttempt();
    try {
      const funnelContext = await beginFunnelAttempt('google').catch(() => undefined);
      const ticket = await runGoogleSignIn({
        platform: Platform.OS,
        signal: attempt.signal,
        onBrowserClosed: () => {
          if (attempt.signal.aborted) return;
          setLoadingAction(null);
          setStatus('idle');
        },
        funnelContext,
        state: randomState(),
        recoveryToken: randomState(),
        openAuthSession: (url, redirect) =>
          openAccountAuthSession(url, redirect, authSessionOptions(Platform.OS, redirect, 'google')),
        subscribeToUrls: subscribeToAuthUrls,
      });
      if (attempt.signal.aborted) return;
      setLoadingAction('google');
      void funnelCallback('success');
      const identityId = await exchangeFunnelTicket(ticket, 'google');
      if (attempt.signal.aborted) return;
      await clearPendingGoogleSignIn().catch(() => undefined);
      await enterAfterMonolithSignIn(identityId);
    } catch (error) {
      if (attempt.signal.aborted) return;
      const cancelled = error instanceof OidcBindError && ['browser_canceled', 'oidc_denied'].includes(error.code);
      void funnelCallback(cancelled ? 'cancelled' : 'error', cancelled ? undefined : 'exchange_failed');
      if (cancelled) {
        setStatus('idle');
        return;
      }
      observeAuth({ name: 'notice_shown', code: authFailureCode(error,'callback_validated'), outcome: 'failed' });
      const next = noticeForAuthError(
        error instanceof OidcBindError
          ? error
          : new OidcBindError('exchange_failed', 'Google sign-in could not finish. Try again.'),
        'google',
      );
      setStatus(next.status);
      setNotice(next);
      publishOnboardingNotice(next);
    } finally {
      if (!attempt.signal.aborted) {
        finishSignInAttempt(attempt);
        setLoadingAction(null);
      }
    }
  };

  const handleSignIn = async () => {
    if (!canSignIn) return;
    setLoadingAction('github');
    setStatus('opening_browser');
    clearOnboardingNotice();
    setNotice(null);
    const attempt = beginSignInAttempt();
    let startedState: string | undefined;
    try {
      const funnelContext=await beginFunnelAttempt('github').catch(()=>undefined);
      const runtime = getBuzzRuntimeConfig();
      const state = randomState();
      startedState = state;
      const challenge = await runResilientGitHubSignInSession({
        platform: Platform.OS,
        signal: attempt.signal,
        onBrowserClosed: () => {
          if (attempt.signal.aborted) return;
          setLoadingAction(null);
          setStatus('idle');
        },
        state,
        recoveryToken: randomState(),
        funnelContext,
        runtime,
        openAuthSession: (authorizationUrl, redirectUri) =>
          openAccountAuthSession(
            authorizationUrl,
            redirectUri,
            authSessionOptions(Platform.OS, redirectUri),
          ),
        subscribeToUrls: subscribeToAuthUrls,
      });
      if (attempt.signal.aborted) return;
      setLoadingAction('github');
      void funnelCallback('success');
      if (repositoryOnboarding) setStatus('binding');
      const identityId = await exchangeFunnelTicket(challenge.ticket);
      if (attempt.signal.aborted) return;
      await clearPendingGitHubSignInState().catch(() => undefined);
      await enterAfterMonolithSignIn(identityId);
    } catch (error) {
      if (attempt.signal.aborted) return;
      const cancelled=error instanceof OidcBindError && ['browser_canceled','github_denied','oidc_denied'].includes(error.code);
      void funnelCallback(cancelled?'cancelled':'error',cancelled?undefined:error instanceof OidcBindError && error.code==='offline'?'offline':'unknown');
      // Leaving the GitHub page is not a failure: free the buttons without a notice.
      if (isGitHubSignInLeft(error)) {
        setStatus('idle');
        void cancelPendingGitHubSignIn(undefined, undefined, startedState).catch(() => undefined);
        return;
      }
      await cancelPendingGitHubSignIn(undefined, undefined, startedState).catch(() => undefined);
      const next = noticeForAuthError(error, 'github');
      observeAuth({name:'notice_shown',code:authFailureCode(error,'callback_validated'),outcome:'failed'});
      setStatus(next.status);
      setNotice(next);
      publishOnboardingNotice(next);
    } finally {
      if (!attempt.signal.aborted) {
        finishSignInAttempt(attempt);
        setLoadingAction(null);
      }
    }
  };

  const handleReplaceDeviceKey = async () => {
    const pending = pendingBind.current;
    if (!pending || loading) return;
    setLoadingAction('recover');
    clearOnboardingNotice();
    setNotice(null);
    try {
      if (pending.challenge.expires_at <= Math.floor(Date.now() / 1_000)) {
        throw new OidcBindError('ticket_expired', 'The recovery ticket expired', 410);
      }
      const event = buildOidcBindEvent(pending.challenge, pending.identity);
      const result = await recoverOidcBind(
        getBuzzRuntimeConfig().relayUrl,
        pending.challenge,
        event,
      );
      pending.managedIdentity = result.identity;
      pending.bound = true;
      await finishPendingBind(pending);
    } catch (error) {
      const next = noticeForAuthError(error, 'github');
      observeAuth({name:'notice_shown',code:authFailureCode(error,'callback_validated'),outcome:'failed'});
      setStatus(next.status);
      setNotice(next);
      publishOnboardingNotice(next);
    } finally {
      setLoadingAction(null);
    }
  };

  const handleNameContinue = async () => {
    if (!namingIdentity) return;
    const normalized = normalizeManagedHandle(nameInput);
    if (!normalized) {
      setNotice({
        status: 'bind_retry',
        title: "HANDLE NOT AVAILABLE",
        message: "Use 3–30 lowercase letters, numbers, or dashes.",
        retryable: false,
      });
      return;
    }
    setLoadingAction('name');
    setNotice(null);
    const clearOnboardingName = onboardingNameDraft.capture();
    try {
      const claim = await monolithPhoneOperation('claimManagedHandle', { handle: normalized });
      try {
        const client = namingClient ?? (await new BuzzRigTransport(namingIdentity).ensureClient());
        const current = await client
          .getGlobalPersonProfile(namingIdentity.publicKey)
          .catch(() => null);
        await client.setGlobalPersonProfile({
          name: claim.name,
          handle: claim.handle,
          avatar: current?.avatar,
        });
      } catch {
        // The authenticated server assignment is authoritative. Profile
        // publication is best-effort here and can reconcile on next launch.
      }
      clearOnboardingName();
      await savePreferredPersonName(namingIdentity.publicKey, claim.name).catch(() => undefined);
      await clearPersonNameOnboardingPending().catch(() => undefined);
      router.replace('/beeline/channels');
    } catch (error) {
      const taken = error instanceof Error && /already claimed/i.test(error.message);
      setNotice({
        status: 'bind_retry',
        title: taken
          ? "HANDLE ALREADY CLAIMED"
          : "HANDLE NOT CLAIMED",
        message: taken
          ? `@${normalized} belongs to someone else. Choose another handle.`
          : appErrorCopy(error),
        retryable: false,
      });
    } finally {
      setLoadingAction(null);
    }
  };

  const canRetryBind = notice?.retryable === true && pendingBind.current !== null;
  // Offline, the one action is the person's own retry; nothing retries for them.
  const signInLabel = notice?.status === 'offline' ? 'Try again' : 'Continue with GitHub';
  const entryBusy = status === 'checking_device' || status === 'binding';
  const noticeLine = notice ? <Problem title={notice.title} message={notice.message} testID="onboarding-notice" /> : null;

  if (namingIdentity) {
    const normalized = normalizeManagedHandle(nameInput);
    return (
      <OnboardingFrame
        stage={1}
        testID="onboarding-handle-ceremony"
        footer={
          <Primary
            disabled={!normalized || loading}
            label="Claim handle"
            busy={loadingAction === 'name'}
            onPress={() => void handleNameContinue()}
            testID="onboarding-claim-handle"
          />
        }
      >
        <Heading title="Choose your handle" line="This name is bound to your key. It becomes your verified Beeline identity everywhere." />
        <Rise order={1}>
          <YStack alignItems="center">
            <IdentityMark kind="human" seed={namingIdentity.publicKey} name={(normalized ?? nameInput) || 'new identity'} size={104} />
          </YStack>
        </Rise>
        <Rise order={2}>
          <YStack gap="2">
            <XStack alignItems="center" gap="2">
              <T v="title" color="secondary">@</T>
              <Input
                flex={1}
                minWidth={0}
                borderColor="strongStroke"
                aria-label="Choose your Beeline handle"
                accessibilityLabel="Choose your Beeline handle"
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                disabled={loading}
                maxLength={30}
                onChangeText={(value: string) => setNameInput(value.toLowerCase())}
                onSubmitEditing={() => void handleNameContinue()}
                placeholder="ada-labs"
                returnKeyType="done"
                testID="onboarding-handle-input"
                value={nameInput}
              />
            </XStack>
            <T v="meta" color="secondary">{normalized ? `@${normalized}` : '3–30 · a–z · 0–9 · dash'}</T>
            {noticeLine}
          </YStack>
        </Rise>
      </OnboardingFrame>
    );
  }

  return (
    <OnboardingFrame
      center
      testID="onboarding-welcome"
      footer={
        <>
          {noticeLine}
          {notice?.status === 'link_conflict' && pendingBind.current ? (
            <>
              <T v="meta" color="secondary">
                Replacing the device key moves this GitHub link to your new key. Your Workspaces,
                Rooms, and repository approvals follow this account — agents and people you work with
                keep working with you, no re-invites.
              </T>
              <Primary
                label="Replace device key"
                busy={loadingAction === 'recover'}
                onPress={() => void handleReplaceDeviceKey()}
                disabled={loading}
                testID="onboarding-replace-device-key"
              />
            </>
          ) : canRetryBind ? (
            <Primary
              label="Retry device bind"
              busy={loadingAction === 'bind'}
              onPress={() => pendingBind.current && void finishPendingBind(pendingBind.current)}
              disabled={loading}
            />
          ) : canSignIn ? (
            <>
              {/* A press in flight never disables either provider: a fresh
                  press starts a fresh attempt (onboarding-state.ts). */}
              <Btn
                kind="primary"
                label={signInLabel}
                minHeight={HEIGHT.tabBar}
                borderRadius="lg"
                testID="onboarding-github-sign-in"
                disabled={entryBusy}
                onPress={() => void handleSignIn()}
              >
                {loadingAction === 'github' || loadingAction === 'bind' || status === 'checking_device'
                  ? <Spinner color="primaryInk" />
                  : signInLabel}
              </Btn>
              <Btn
                label="Continue with Google"
                minHeight={HEIGHT.tabBar}
                borderRadius="lg"
                testID="onboarding-google-sign-in"
                disabled={entryBusy}
                onPress={() => void handleGoogleSignIn()}
              >
                {loadingAction === 'google' ? <Spinner color="ink" /> : 'Continue with Google'}
              </Btn>
              {notice ? null : <T v="meta" color="secondary" textAlign="center">GitHub is recommended.</T>}
            </>
          ) : null}
        </>
      }
    >
      <BeelineMark size={120} shimmer />
      <Rise>
        <YStack alignItems="center" gap="2">
          <T v="title" testID="onboarding-wordmark">beeline<T v="title" color="needsYou">.</T></T>
          <T v="body" color="secondary" textAlign="center" testID="onboarding-tagline">workspace for all intelligence</T>
        </YStack>
      </Rise>
    </OnboardingFrame>
  );
}
