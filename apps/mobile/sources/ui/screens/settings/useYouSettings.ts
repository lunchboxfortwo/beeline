import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Updates from 'expo-updates';
import { router } from 'expo-router';
import { fallbackPersonName, personHandle, isWorkspaceListView, isWorkspaceView, type Identity } from '@beeline/buzz-client';
import type { PushLevel } from '@beeline/api-contract/phone';
import { checkNativeUpdate, reloadNativeUpdate } from '@/hooks/useUpdates';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { reportClientError } from '@/buzz/client-error-report';
import { getEffectiveRelayUrl, clearBuzzIdentity, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { useActiveCommunityId } from '@/buzz/use-active-community';
import { loadPreferredPersonName } from '@/buzz/person-name';
import { workbenchSummary } from '@/buzz/connectors-model';
import { useSharedWorkbench } from '@/buzz/workbench-surface';
import { isManagedIdentity, publishManagedIdentity, readIdentitySettings } from '@/buzz/managed-identity-surface';
import { useSurfaceSnapshot } from '@/buzz/use-shared-surface';
import { pickAndUploadAvatar } from '@/buzz/avatar-upload';
import { BuzzRigTransport } from '@/sync/transport';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import {
    getBuzzPushEnabled, getBuzzPushRegistrationState, registerBuzzPushNotifications, setBuzzPushEnabled,
    type BuzzPushRegistrationResult, type BuzzPushRegistrationState,
} from '@/push/buzz-push-registration';
import { buzzPushPhaseDetail, pushSwitchValue } from '@/push/buzz-push-status';
import { getPushPermissionInfo, type PushPermissionInfo } from '@/sync/pushRegistration';
import { githubConnectionErrorMessage } from '@/auth/github-connection-error';
import { clearPendingGitHubSignInState } from '@/auth/github-auth-session';
import { monolithSession } from '@/auth/monolith-session';
import { clearMobileSurfaceStorage, surfaceAddress } from '@/buzz/surface-storage';
import { saveStoredPushLevel, watchStoredPushLevel } from '@/push/push-level-storage';
import { subscribeOwnIdentityChange } from '@/buzz/identity-live';
import { reconcilePresentedNotificationBadge } from '@/push/presented-notifications';
import { loadAppConfig } from '@/sync/appConfig';
import {
    createManualUpdateState, isManualUpdateBusy, manualUpdateButtonLabel, manualUpdateMessage, manualUpdateReducer,
} from '@/app/(app)/beeline/settings/manual-update-state';

/**
 * Everything Settings → You reads and writes: the managed identity (name,
 * handle, picture, sign-in providers, push level, speaking speed), the
 * Workspace list for the scope tabs, this device's push registration, and the
 * account actions. Every value is a server projection or a device setting;
 * nothing is computed here that the server owns.
 */
export function useYouSettings({ linkedWorkspaceId, githubReconnect, githubConnectionError, showWorkbench = true }: {
    linkedWorkspaceId?: string; githubReconnect?: string; githubConnectionError?: string; showWorkbench?: boolean;
}) {
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [identity, setIdentity] = useState<Identity | null>(null);
    const [profileName, setProfileName] = useState('');
    const [relay, setRelay] = useState<string | null>(null);
    const [pushEnabled, setPushEnabledState] = useState<boolean | null>(null);
    const [pushRegistration, setPushRegistration] = useState<BuzzPushRegistrationState | null>(null);
    const [pushPermission, setPushPermission] = useState<PushPermissionInfo | null>(null);
    const [pushWorking, setPushWorking] = useState(false);
    const [pushLevel, setPushLevel] = useState<PushLevel>('attention');
    const currentWorkspaceId = useActiveCommunityId();
    const settingsWorkspaceId = linkedWorkspaceId ?? currentWorkspaceId;
    const pubkey = identity?.publicKey ?? null;

    const managedAddress = useMemo(() => relay && pubkey ? surfaceAddress(relay, pubkey, '/identity/managed') : null, [relay, pubkey]);
    const managed = useSurfaceSnapshot(managedAddress, isManagedIdentity);
    const listAddress = useMemo(() => relay && pubkey ? surfaceAddress(relay, pubkey, '/workspaces') : null, [relay, pubkey]);
    const workspaceList = useSurfaceSnapshot(listAddress, isWorkspaceListView);
    const workspaces = workspaceList?.workspaces ?? [];
    // A link to one workspace's settings names it; otherwise Settings shows the current one.
    const selected = workspaces.find((item) => item.id === linkedWorkspaceId) ??
        workspaces.find((item) => item.id === currentWorkspaceId) ?? workspaces[0];
    const selectedAddress = useMemo(() => relay && pubkey && selected
        ? surfaceAddress(relay, pubkey, '/workspace/:id', { workspaceId: selected.id }) : null, [relay, pubkey, selected?.id]);
    // The tab's own read, when it has one, is fresher than the list (a new picture or name).
    const selectedView = useSurfaceSnapshot(selectedAddress, isWorkspaceView);
    const workspace = selected && selectedView?.workspace.id === selected.id ? { ...selected, ...selectedView.workspace } : selected;
    const role = selected?.role ?? null;
    const canManageWorkspace = role === 'owner' || role === 'admin';

    const workbenchScope = (showWorkbench || !canManageWorkspace) && selected && pubkey ? { workspaceId: selected.id, viewerId: pubkey } : null;
    const { value: workbenchView } = useSharedWorkbench(workbenchScope);
    const workbench = workbenchView && workbenchScope ? workbenchSummary(workbenchView, workbenchScope.viewerId) : null;

    useEffect(() => {
        if (githubConnectionError) setNotice(githubConnectionErrorMessage(githubConnectionError));
        else if (githubReconnect === 'success') setNotice('GitHub reconnected.');
        else if (githubReconnect === 'mismatch') setNotice('Reconnect the GitHub account already linked to this identity.');
        else if (githubReconnect === 'failed') setNotice('Could not reconnect GitHub. Try again.');
    }, [githubReconnect, githubConnectionError]);

    // The profile is read for the current Workspace, again after a switch.
    useEffect(() => {
        if (settingsWorkspaceId === undefined) return;
        let cancelled = false;
        void (async () => {
            try {
                const next = await loadBuzzIdentity();
                if (!next) return;
                if (!cancelled) {
                    setIdentity(next);
                    setProfileName((current) => current || fallbackPersonName(next.publicKey));
                }
                const preferred = await loadPreferredPersonName(next.publicKey);
                if (preferred && !cancelled) setProfileName(preferred);
                setRelay(await getEffectiveRelayUrl());
                const [settings, enabled, registration, permission] = await Promise.all([
                    readIdentitySettings(settingsWorkspaceId ?? undefined),
                    getBuzzPushEnabled(next.publicKey),
                    getBuzzPushRegistrationState(next.publicKey),
                    getPushPermissionInfo(),
                ]);
                if (cancelled) return;
                setPushEnabledState(enabled);
                setPushRegistration(registration);
                setPushPermission(permission);
                await saveStoredPushLevel(next.publicKey, settings.identity.pushLevel);
            } catch (caught) {
                if (!cancelled) setError(appErrorCopy(caught, ''));
            }
        })();
        return () => { cancelled = true; };
    }, [settingsWorkspaceId]);

    useEffect(() => {
        // A change on another device reaches this page through the server's identity subscription.
        if (!pubkey) return;
        const stopLevel = watchStoredPushLevel(pubkey, setPushLevel);
        const stopIdentity = subscribeOwnIdentityChange((person) => setProfileName(person.name));
        return () => { stopLevel(); stopIdentity(); };
    }, [pubkey]);

    // A Google link started on this page finishes here after the browser hands back.
    useEffect(() => {
        if (!pubkey) return;
        void (async () => {
            const google = await import('@/auth/google-auth-session');
            if (await google.pendingGoogleLinkIdentity() !== pubkey) return;
            const { getInitialURL } = await import('expo-linking');
            const ticket = await google.resumeGoogleSignIn(await getInitialURL());
            if (!ticket) return;
            await google.completeGoogleAccountLink(ticket, pubkey);
            await publishManagedIdentity(await monolithPhoneOperation('getManagedIdentity', {}));
        })().catch((reason) => setNotice(appErrorCopy(reason)));
    }, [pubkey]);

    const [busy, setBusy] = useState<'google' | 'github' | 'picture' | 'delete' | null>(null);
    const connectGoogle = async () => {
        if (busy || !pubkey) return;
        setBusy('google');
        setNotice(null);
        try {
            const [{ runGoogleSignIn, completeGoogleAccountLink }, { getRandomBytes }, { openAccountAuthSession, subscribeToAuthUrls }, { authSessionOptions }] = await Promise.all([
                import('@/auth/google-auth-session'), import('expo-crypto'), import('@/auth/desktop-auth-session'), import('@/auth/auth-session'),
            ]);
            const token = () => btoa(String.fromCharCode(...getRandomBytes(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
            const ticket = await runGoogleSignIn({
                state: token(), recoveryToken: token(), linkIdentity: pubkey,
                openAuthSession: (url, redirect) => openAccountAuthSession(url, redirect, authSessionOptions(Platform.OS, redirect)),
                subscribeToUrls: subscribeToAuthUrls,
            });
            await completeGoogleAccountLink(ticket, pubkey);
            await publishManagedIdentity(await monolithPhoneOperation('getManagedIdentity', {}));
        } catch (reason) { setNotice(appErrorCopy(reason)); } finally { setBusy(null); }
    };
    const connectGitHub = async () => {
        if (busy) return;
        setBusy('github');
        setNotice(null);
        try {
            const [{ runHostGitHubInstallationSession }, { githubInstallationRedirectUri }] = await Promise.all([
                import('@/auth/github-installation-host'), import('@/auth/github-auth-session'),
            ]);
            await runHostGitHubInstallationSession({
                returnPath: '/beeline/settings',
                startInstallation: async () => (await monolithPhoneOperation('beginGitHubInstallation', {
                    redirectUri: githubInstallationRedirectUri(), reconnect: true,
                })).url,
                refreshRepositories: async () => {
                    await monolithPhoneOperation('listGitHubRepositories', { refresh: true });
                    await publishManagedIdentity(await monolithPhoneOperation('getManagedIdentity', {}));
                },
                onRefreshPhase: () => undefined,
            });
        } catch (reason) { setNotice(appErrorCopy(reason)); } finally { setBusy(null); }
    };

    /** Settings → You → Profile picture: the same picker and upload the Workspace picture uses. */
    const changePicture = async (remove = false) => {
        if (busy || !identity) return;
        setBusy('picture');
        setError(null);
        try {
            let avatar = '';
            if (!remove) {
                const picked = await pickAndUploadAvatar(await new BuzzRigTransport(identity).ensureClient());
                if (!picked) return;
                avatar = picked;
            }
            await monolithPhoneOperation('updatePersonProfile', { avatar });
            await publishManagedIdentity(await monolithPhoneOperation('getManagedIdentity', {}));
        } catch (caught) { setError(appErrorCopy(caught)); } finally { setBusy(null); }
    };

    const signOut = useCallback(async () => {
        await Promise.all([monolithSession.signOut(), clearBuzzIdentity(), clearPendingGitHubSignInState()]);
        clearMobileSurfaceStorage();
        router.replace('/beeline/onboarding');
    }, []);
    const deleteAccount = async () => {
        if (busy === 'delete') return;
        setBusy('delete');
        try {
            const current = identity ?? (await loadBuzzIdentity());
            if (!current) throw new Error('identity unavailable');
            await new BuzzRigTransport(current).deleteAccount();
            await Promise.all([monolithSession.clear(), clearBuzzIdentity(), clearPendingGitHubSignInState()]);
            clearMobileSurfaceStorage();
            router.replace('/beeline/onboarding');
        } catch (caught) {
            // Keep the friendly copy, but record the real cause for diagnosis.
            console.warn('[ACCOUNT] Delete account failed:', caught);
            void reportClientError('app', caught);
            setError('Could not delete the account. Try again.');
            setBusy(null);
        }
    };

    const updateRunning = useRef(false);
    const [manualUpdate, dispatchUpdate] = useReducer(manualUpdateReducer, Updates.isEnabled, createManualUpdateState);
    const checkForUpdate = useCallback(async () => {
        if (!Updates.isEnabled || updateRunning.current) return;
        updateRunning.current = true;
        dispatchUpdate({ type: 'start-check' });
        try {
            const update = await checkNativeUpdate((stage) => dispatchUpdate({ type: stage === 'available' ? 'update-available' : 'update-downloaded' }));
            if (!update.available) {
                if (update.downloadFailed) throw new Error('download failed');
                dispatchUpdate({ type: 'latest' });
                return;
            }
            await reloadNativeUpdate();
        } catch {
            dispatchUpdate({ type: 'failed' });
        } finally {
            updateRunning.current = false;
        }
    }, []);
    const release = loadAppConfig();

    const applyPushResult = async (current: Identity, result: BuzzPushRegistrationResult) => {
        setPushRegistration({ ...result, updatedAt: Date.now() });
        setPushEnabledState(await getBuzzPushEnabled(current.publicKey));
        setPushPermission(await getPushPermissionInfo());
    };
    const pushOn = pushSwitchValue(pushEnabled, pushRegistration);
    const retryPush = async () => {
        if (!identity || pushWorking) return;
        setPushWorking(true);
        setError(null);
        try {
            await applyPushResult(identity, await registerBuzzPushNotifications(identity));
        } catch (caught) {
            setError(appErrorCopy(caught, `Could not retry push registration.`));
        } finally { setPushWorking(false); }
    };
    const changePushLevel = async (next: PushLevel) => {
        if (!identity || pushWorking) return;
        setPushWorking(true);
        setError(null);
        try {
            const updated = await monolithPhoneOperation('updateIdentityPushLevel', { pushLevel: next });
            await publishManagedIdentity(updated);
            await saveStoredPushLevel(identity.publicKey, updated.pushLevel);
            if (updated.pushLevel === 'off') {
                const notifications = await import('expo-notifications');
                await reconcilePresentedNotificationBadge(notifications, Platform.OS, 'off');
            } else if (!pushOn) {
                await applyPushResult(identity, await setBuzzPushEnabled(identity, true));
            }
        } catch (caught) {
            setError(appErrorCopy(caught, `Could not update notifications.`));
        } finally { setPushWorking(false); }
    };
    const changeSpeakingSpeed = (speakingSpeed: 1.15 | 1.3 | 1.5) => {
        void monolithPhoneOperation('updateIdentitySpeakingSpeed', { speakingSpeed })
            .then(publishManagedIdentity).catch((caught) => setError(appErrorCopy(caught, 'Could not save speaking speed')));
    };

    const shownPushLevel = managed?.pushLevel ?? pushLevel;
    const pushFailure = shownPushLevel !== 'off' && pushEnabled === true && pushRegistration !== null &&
        !pushRegistration.registered ? buzzPushPhaseDetail(pushRegistration.phase) : null;
    const name = managed?.name ?? profileName;
    const handle = managed?.handle ?? (name ? personHandle(name, pubkey ?? '') : '');

    return {
        error, notice, pubkey, name, handle, avatar: managed?.avatar, providers: managed ? managed.providers ?? [] : null,
        role, workspace, canManageWorkspace, workbench, workspacesReady: workspaceList !== null,
        push: {
            supported: pushPermission !== null && pushPermission.status !== 'unsupported',
            level: shownPushLevel, disabled: pushEnabled === null || pushWorking, working: pushWorking,
            failure: pushFailure, retry: () => void retryPush(), change: changePushLevel,
        },
        speakingSpeed: managed?.speakingSpeed ?? 1.15, changeSpeakingSpeed,
        busy, connectGoogle, connectGitHub, changePicture, signOut, deleteAccount,
        update: {
            enabled: Updates.isEnabled, busy: isManualUpdateBusy(manualUpdate), message: manualUpdateMessage(manualUpdate),
            label: manualUpdateButtonLabel(manualUpdate), check: () => void checkForUpdate(),
            version: `${release.releaseVersion ?? 'development'}${release.releaseSha ? ` · ${release.releaseSha.slice(0, 12)}` : ''}`,
        },
    };
}
export type YouSettings = ReturnType<typeof useYouSettings>;
