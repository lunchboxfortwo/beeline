import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Input, ListItem, Spinner, XStack, YStack } from 'tamagui';
import { Bot, Check, Link, Lock, Mail, Sparkles, Terminal, Users } from 'lucide-react-native';
import { router } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { isWorkspaceListView, type Identity, type WorkspaceListView } from '@beeline/buzz-client';
import { Btn, Copy, CopyLine, Glyph, T } from '@/ui/grammar';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { agentPairingCommand } from '@/buzz/agent-pairing-command';
import { buildCommunityInviteUrl, parseCommunityInviteToken, resolveCommunityInvitePublicOrigin } from '@/buzz/community-invite';
import { saveActiveCommunityId } from '@/buzz/community-storage';
import { enterWorkspaceRoom } from '@/buzz/enter-workspace';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { Choice, Heading, OnboardingFrame, Primary, Problem, type Stage } from './OnboardingFrame';
import { Rise } from './Rise';
import { YouStep } from './YouStep';

type Step = 'you' | 'workspace' | 'create' | 'invite' | 'teammates' | 'agents' | 'connect';
const STAGE: Record<Step, Stage> = { you: 1, workspace: 2, create: 2, invite: 3, teammates: 3, agents: 3, connect: 3 };
/** Where a route opens the flow: the choice, straight on Create, or on the invite field. */
export type SetupEntry = 'workspace' | 'create' | 'join';

const looksLikeEmail = (value: string) => /.+@.+\..+/.test(value.trim());
const copyLine = async (line: string) => { await (await import('expo-clipboard')).setStringAsync(line); };

/**
 * After sign-in, a person with no Workspace goes you → workspace → create →
 * invite (teammates, agents) → #general, where the free agents greet them
 * (build spec decision 29). The sidebar's + opens the same flow on the
 * workspace choice. The Workspace and its public `#general` are created
 * under an id chosen once here, so a retried create never makes a second one.
 */
export function WorkspaceSetup({ route, entry = 'workspace' }: { route: string; entry?: SetupEntry }) {
    useLatencyRouteFrame(route);
    const workspaceId = useRef(Crypto.randomUUID()).current;
    // A create is attempted before its answer is known, so what the server
    // HOLDS is only what a call has confirmed: null means unknown, and an
    // unknown name is rewritten rather than assumed.
    const createAttempted = useRef(false);
    const confirmedName = useRef<string | null>(null);
    const [identity, setIdentity] = useState<Identity | null>(null);
    const [workspaceList, setWorkspaceList] = useState<WorkspaceListView | null>(null);
    const [listFailed, setListFailed] = useState(false);
    const [step, setStep] = useState<Step | null>(null);
    const [trail, setTrail] = useState<Step[]>([]);
    const [joinOpen, setJoinOpen] = useState(entry === 'join');
    const [inviteInput, setInviteInput] = useState('');
    const [draftName, setDraftName] = useState<string | null>(null);
    const [open, setOpen] = useState(false);
    const [working, setWorking] = useState(false);
    const [created, setCreated] = useState<{ id: string; roomId: string | null } | null>(null);
    const [inviteLink, setInviteLink] = useState<string | null>(null);
    const [pairCommand, setPairCommand] = useState<string | null>(null);
    const [email, setEmail] = useState('');
    const [sending, setSending] = useState(false);
    const [invited, setInvited] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const current = await loadBuzzIdentity();
                if (!current) {
                    router.replace('/beeline/onboarding');
                    return;
                }
                const relayUrl = await getEffectiveRelayUrl();
                const address = surfaceAddress(relayUrl, current.publicKey, '/workspaces');
                const cached = await mobileSurfaceCache.read(address, isWorkspaceListView);
                if (cancelled) return;
                setIdentity(current);
                if (cached) setWorkspaceList(cached);
                const fresh = await new RoomViewClient({ baseUrl: relayUrl, identity: current }).workspaces().catch(() => null);
                if (cancelled) return;
                if (!fresh) { setListFailed(true); return; }
                setWorkspaceList(fresh);
                void mobileSurfaceCache.write(address, fresh, isWorkspaceListView);
            } catch (reason) {
                if (!cancelled) { setListFailed(true); setError(appErrorCopy(reason)); }
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const firstEntry = workspaceList?.workspaces.length === 0;
    const hasWorkspaces = (workspaceList?.workspaces.length ?? 0) > 0;
    // The opening step is chosen once, when the person's Workspaces are known.
    useEffect(() => {
        if (step || (!workspaceList && !listFailed)) return;
        setStep(entry === 'create' ? 'create' : firstEntry && entry === 'workspace' ? 'you' : 'workspace');
    }, [entry, firstEntry, listFailed, step, workspaceList]);

    useLatencyRouteFrame(route, step !== null, true);

    const go = (next: Step) => { if (step) setTrail((previous) => [...previous, step]); setError(null); setStep(next); };
    const leave = hasWorkspaces
        ? () => (router.canGoBack() ? router.back() : router.replace('/beeline/channels'))
        : undefined;
    const back = step === 'invite' ? undefined : trail.length > 0
        ? () => { setError(null); setStep(trail[trail.length - 1]!); setTrail(trail.slice(0, -1)); }
        : leave;

    const viewerName = workspaceList?.viewer.name?.trim() ?? '';
    const workspaceName = draftName ?? (viewerName ? `${viewerName}'s team` : 'My team');

    const createWorkspace = async () => {
        const name = workspaceName.trim();
        if (!identity || !name || working) return;
        setWorking(true);
        setError(null);
        const firstAttempt = !createAttempted.current;
        createAttempted.current = true;
        try {
            const made = await monolithPhoneOperation('createWorkspace', {
                workspaceId, name, ...(firstEntry ? { creationSource: 'onboarding' as const } : {}),
            });
            // The create is idempotent on this id: only the first attempt can have
            // inserted this name, so a retry after an edit writes the rename.
            if (firstAttempt) confirmedName.current = name;
            const rename = confirmedName.current !== name;
            if (rename || open) {
                await monolithPhoneOperation('updateWorkspace', {
                    workspaceId, ...(rename ? { name } : {}), ...(open ? { visibility: 'public' as const } : {}),
                });
                confirmedName.current = name;
            }
            await saveActiveCommunityId(identity.publicKey, made.id);
            setCreated({ id: made.id, roomId: made.roomId ?? null });
            setTrail([]);
            setStep('invite');
        } catch (reason) {
            setError(appErrorCopy(reason, 'Could not create Workspace.'));
        } finally {
            setWorking(false);
        }
    };

    const handleJoin = useCallback(() => {
        const token = parseCommunityInviteToken(inviteInput);
        if (!token) {
            setError('That is not a Beeline invite link. Paste the whole link you were sent.');
            return;
        }
        setError(null);
        router.push({ pathname: '/join/[token]', params: { token } });
    }, [inviteInput]);

    const openTeammates = async () => {
        go('teammates');
        if (inviteLink || !created) return;
        try {
            const invite = await monolithPhoneOperation('createInvite', { workspaceId: created.id });
            setInviteLink(buildCommunityInviteUrl(invite.token, resolveCommunityInvitePublicOrigin(getBuzzRuntimeConfig())));
        } catch (reason) {
            setError(appErrorCopy(reason));
        }
    };
    const sendEmail = async () => {
        const address = email.trim();
        if (!created || !looksLikeEmail(address) || sending) return;
        setSending(true);
        setError(null);
        try {
            await monolithPhoneOperation('inviteByEmail', { workspaceId: created.id, email: address });
            setInvited((previous) => [...previous, address]);
            setEmail('');
        } catch (reason) {
            setError(appErrorCopy(reason, 'Could not create person invite.'));
        } finally {
            setSending(false);
        }
    };
    const openConnect = async () => {
        go('connect');
        if (pairCommand || !created) return;
        try {
            const pairing = await monolithPhoneOperation('createAgentPairingCode', { workspaceId: created.id });
            setPairCommand(agentPairingCommand(pairing.code));
        } catch (reason) {
            setError(appErrorCopy(reason, 'Could not create agent invite.'));
        }
    };
    const backToInvite = () => { setError(null); setTrail([]); setStep('invite'); };
    const problem = error ? <Problem message={error} testID={step === 'create' ? 'create-error' : 'choice-error'} /> : null;

    if (!step) {
        return (
            <OnboardingFrame center testID="workspace-choice-loading">
                <SurfaceGlyphLoader testID="community-loader" />
            </OnboardingFrame>
        );
    }
    if (step === 'you') return <YouStep back={back} onDone={() => go('workspace')} />;

    const frame = { stage: STAGE[step], back, testID: `onboarding-${step}` };
    if (step === 'workspace') {
        return (
            <OnboardingFrame {...frame}>
                <Heading title="Where will you work?" />
                <Rise order={1}>
                    <YStack gap="3">
                        <Choice accent icon={Sparkles} title="Create a workspace" line="Your own place for chats, agents and keys."
                            onPress={() => go('create')} testID="choice-create" />
                        <Choice icon={Users} title="Join with an invite link" line="Paste the link someone sent you" expanded={joinOpen}
                            onPress={() => { setJoinOpen((value) => !value); setError(null); }} testID="choice-join" />
                        {joinOpen ? (
                            <YStack gap="2" testID="choice-join-form">
                                <Input borderColor="strongStroke" aria-label="Invite link" accessibilityLabel="Invite link" testID="choice-join-input"
                                    autoCapitalize="none" autoCorrect={false} autoFocus keyboardType="url" placeholder="usebeeline.app/join/…"
                                    value={inviteInput} onChangeText={setInviteInput} onSubmitEditing={handleJoin} />
                                <Btn label="Preview invite" disabled={!inviteInput.trim()} onPress={handleJoin} testID="choice-join-preview">Preview invite</Btn>
                            </YStack>
                        ) : null}
                        {problem}
                    </YStack>
                </Rise>
            </OnboardingFrame>
        );
    }
    if (step === 'create') {
        return (
            <OnboardingFrame {...frame} footer={
                <Primary label="Create workspace" disabled={!workspaceName.trim()} busy={working} onPress={() => void createWorkspace()} testID="create-continue" />
            }>
                <Heading title="Name your workspace" />
                <Rise order={1}>
                    <XStack gap="4" alignItems="center">
                        <IdentityMark kind="workspace" seed={workspaceId} name={workspaceName.trim() || 'Workspace'} size={64} />
                        <Input flex={1} minWidth={0} borderColor="needsYou" aria-label="Workspace name" accessibilityLabel="Workspace name"
                            testID="create-workspace-name" maxLength={80} disabled={working} value={workspaceName}
                            onChangeText={setDraftName} onSubmitEditing={() => void createWorkspace()} />
                    </XStack>
                </Rise>
                <Rise order={2}>
                    <YStack gap="2">
                        <T v="metaStrong" color="secondary">Who can join</T>
                        {[
                            { value: false, label: 'Invite only', line: 'People and agents join when you invite them.' },
                            { value: true, label: 'Anyone with the link', line: 'Whoever has the link can join.' },
                        ].map((option) => (
                            <ListItem key={option.label} padding="3" gap="3" borderRadius="md" borderWidth={1}
                                borderColor={open === option.value ? 'needsYou' : 'stroke'} backgroundColor={open === option.value ? 'highlight' : 'raised'}
                                onPress={() => setOpen(option.value)} aria-label={option.label} accessibilityRole="radio"
                                accessibilityState={{ checked: open === option.value }} testID={option.value ? 'create-open' : 'create-invite-only'}>
                                <YStack width={20} height={20} borderRadius="full" borderWidth={1.5} borderColor={open === option.value ? 'needsYou' : 'strongStroke'} alignItems="center" justifyContent="center">
                                    {open === option.value ? <YStack width={10} height={10} borderRadius="full" backgroundColor="needsYou" /> : null}
                                </YStack>
                                <YStack flex={1} minWidth={0}><Copy strong>{option.label}</Copy><Copy small quiet>{option.line}</Copy></YStack>
                                {option.value ? null : <Glyph icon={Lock} size={16} />}
                            </ListItem>
                        ))}
                        {problem}
                    </YStack>
                </Rise>
            </OnboardingFrame>
        );
    }
    if (step === 'invite') {
        const name = workspaceName.trim();
        return (
            <OnboardingFrame {...frame} footer={
                <Primary label="Go to #general" onPress={() => created && enterWorkspaceRoom(created.id, created.roomId)} testID="go-general" />
            }>
                <Heading title="Who’s joining you?" line={firstEntry ? `Beebee and Luna, two free agents, already live in ${name}.` : undefined} />
                <Rise order={1}>
                    <YStack gap="3">
                        <Choice icon={Users} title="Invite teammates" line="Send a link or an email invite." onPress={() => void openTeammates()} testID="invite-teammates" />
                        <Choice accent icon={Bot} title="Invite agents" line="Connect your own coding agent." onPress={() => go('agents')} testID="invite-agents" />
                        {invited.length ? <T v="meta" color="needsYou" testID="invites-sent">{`${invited.length} invite${invited.length > 1 ? 's' : ''} sent`}</T> : null}
                    </YStack>
                </Rise>
            </OnboardingFrame>
        );
    }
    if (step === 'teammates') {
        return (
            <OnboardingFrame {...frame} footer={<Primary label="Done" onPress={backToInvite} testID="teammates-done" />}>
                <Heading title="Invite teammates" />
                <Rise order={1}>
                    <YStack gap="2">
                        <XStack gap="2" alignItems="center"><Glyph icon={Link} size={16} /><T v="metaStrong" color="secondary">Invite link</T></XStack>
                        {inviteLink ? <CopyLine line={inviteLink} label="Copy invite link" onCopy={copyLine} />
                            : error ? null : <Spinner color="secondary" testID="invite-link-loader" />}
                    </YStack>
                </Rise>
                <Rise order={2}>
                    <YStack gap="2">
                        <XStack gap="2" alignItems="center"><Glyph icon={Mail} size={16} /><T v="metaStrong" color="secondary">Email</T></XStack>
                        <XStack gap="2">
                            <Input flex={1} minWidth={0} borderColor="strongStroke" aria-label="Teammate email" accessibilityLabel="Teammate email"
                                testID="teammate-email" placeholder="name@company.com" autoCapitalize="none" autoCorrect={false}
                                keyboardType="email-address" value={email} onChangeText={setEmail} onSubmitEditing={() => void sendEmail()} />
                            <Btn label="Send invite" disabled={!looksLikeEmail(email) || sending} onPress={() => void sendEmail()} testID="teammate-send">Send</Btn>
                        </XStack>
                        {invited.map((address) => (
                            <XStack key={address} gap="2" alignItems="center" testID="teammate-invited">
                                <Glyph icon={Check} size={14} accent /><Copy small>{address}</Copy><Copy small quiet>invited</Copy>
                            </XStack>
                        ))}
                        {problem}
                    </YStack>
                </Rise>
            </OnboardingFrame>
        );
    }
    if (step === 'agents') {
        return (
            <OnboardingFrame {...frame}>
                <Heading title="Invite agents" />
                <Rise order={1}>
                    <Choice accent icon={Terminal} title="Connect your coding agent"
                        line="Claude Code, Codex or another agent on your computer joins with one command."
                        onPress={() => void openConnect()} testID="agent-connect" />
                </Rise>
            </OnboardingFrame>
        );
    }
    return (
        <OnboardingFrame {...frame} footer={<Primary label="Done" onPress={backToInvite} testID="connect-continue" />}>
            <Heading title="Connect your coding agent" line="Run this on the computer where your agent works." />
            <Rise order={1}>
                <YStack gap="2">
                    {pairCommand ? <CopyLine line={pairCommand} label="Copy connect command" onCopy={copyLine} />
                        : error ? null : <Spinner color="secondary" testID="pair-command-loader" />}
                    {problem}
                </YStack>
            </Rise>
        </OnboardingFrame>
    );
}
