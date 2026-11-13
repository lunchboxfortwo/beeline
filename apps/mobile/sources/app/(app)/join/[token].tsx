import { appErrorCopy } from '@/buzz/app-error-copy';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ListItem, Spinner, YStack } from 'tamagui';
import { Sparkles } from 'lucide-react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useURL } from 'expo-linking';
import type { Identity } from '@beeline/buzz-client';
import type { InviteView } from '@beeline/api-contract/phone';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { parseCommunityInviteToken, resolveCommunityInviteRelayUrl } from '@/buzz/community-invite';
import { saveActiveCommunityId } from '@/buzz/community-storage';
import { inviteSummary } from '@/buzz/invite-summary';
import { enterWorkspaceRoom } from '@/buzz/enter-workspace';
import { clearPendingInvite, savePendingInvite } from '@/buzz/pending-invite';
import { WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { Btn, T } from '@/ui/grammar';
import { Choice, Heading, OnboardingFrame, OrRule, Problem } from '@/ui/screens/onboarding/OnboardingFrame';
import { Rise } from '@/ui/screens/onboarding/Rise';
import { YouStep } from '@/ui/screens/onboarding/YouStep';
import { RoomViewClient, RoomViewHttpError } from '@/sync/transport/room-view-client';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

/**
 * The join path (build spec decision 29): welcome → you → workspace (join)
 * → that Workspace's #general. A verified invite link names the Workspace
 * and who invited you; one confirmation joins it and the first Room you can
 * open opens. Someone with no Workspace yet says who they are first. Opened
 * before sign-in, the link is kept on the device and comes back here after
 * sign-in, and it is spent only once the server has given a verdict: a
 * resolved invite, or a definitive refusal. A link the server says is gone
 * shows its own repair state; a request that never reached the server says
 * so and offers a retry, because the invite is probably still good.
 */
/** The server answers 404 for an invite that is missing, expired or used up. */
const inviteIsGone = (reason: unknown) =>
  reason instanceof RoomViewHttpError && reason.status === 404;

export default function CommunityInviteJoin() {
  useLatencyRouteFrame('/join/[token]');
  const { token: routeToken } = useLocalSearchParams<{ token?: string | string[] }>();
  const incomingUrl = useURL();
  const token = parseCommunityInviteToken(routeToken);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [preview, setPreview] = useState<InviteView | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<'gone' | 'unreachable' | null>(null);
  const [attempt, setAttempt] = useState(0);
  // A first entry says who they are before joining; a public link then joins at once.
  const [step, setStep] = useState<'you' | 'workspace'>('workspace');
  const [joinAfterYou, setJoinAfterYou] = useState(false);
  const joinInFlight = useRef(false);

  const redeem = useCallback(async (currentIdentity: Identity) => {
    const redemption = await monolithPhoneOperation('redeemInvite', { token: token! });
    await saveActiveCommunityId(currentIdentity.publicKey, redemption.workspaceId);
    enterWorkspaceRoom(redemption.workspaceId, redemption.roomId);
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!token) {
        await clearPendingInvite();
        setFailure('gone');
        setLoading(false);
        return;
      }
      try {
        const [currentIdentity, configuredRelayUrl] = await Promise.all([
          loadBuzzIdentity(),
          getEffectiveRelayUrl(),
        ]);
        if (!currentIdentity) {
          // Keep the invite through the sign-in ceremony; the deck brings the
          // person back here once they have an identity.
          await savePendingInvite(token);
          router.replace('/beeline/onboarding');
          return;
        }
        const url = resolveCommunityInviteRelayUrl(incomingUrl, token, configuredRelayUrl);
        const view = new RoomViewClient({ baseUrl: url, identity: currentIdentity });
        const [invite, workspaces] = await Promise.all([
          view.invite(token),
          Promise.resolve().then(() => view.workspaces()).catch(() => null),
        ]);
        const firstEntry = workspaces?.workspaces?.length === 0;
        // The server has answered: the parked copy has done its job.
        await clearPendingInvite();
        if (invite.joinedWorkspaceId) {
          await saveActiveCommunityId(currentIdentity.publicKey, invite.joinedWorkspaceId);
          if (!cancelled) enterWorkspaceRoom(invite.joinedWorkspaceId, null);
          return;
        }
        if (invite.expiresAt === 0 && !firstEntry) {
          // A permanent public link is an open join action. After sign-in,
          // use the same redemption path and go straight into its first Room.
          if (cancelled) return;
          await redeem(currentIdentity);
          return;
        }
        if (!cancelled) {
          setIdentity(currentIdentity);
          setPreview(invite);
          setJoinAfterYou(invite.expiresAt === 0);
          setStep(firstEntry ? 'you' : 'workspace');
        }
      } catch (err) {
        // Only a definitive refusal spends the parked invite; a request that
        // never got an answer leaves it for the next try.
        if (inviteIsGone(err)) await clearPendingInvite();
        if (!cancelled) {
          setError(appErrorCopy(err));
          setFailure(inviteIsGone(err) ? 'gone' : 'unreachable');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt, incomingUrl, redeem, token]);

  const handleJoin = useCallback(async () => {
    if (!token || !preview || !identity || joinInFlight.current) return;
    joinInFlight.current = true;
    setJoining(true);
    setError(null);
    try {
      await redeem(identity);
    } catch (err) {
      joinInFlight.current = false;
      setError(appErrorCopy(err, `Could not join.`));
    } finally {
      setJoining(false);
    }
  }, [identity, preview, redeem, token]);

  const otherWay = useCallback(async (params?: { step: 'create' }) => {
    // Declining is a real way out: the parked copy is spent here, or the deck
    // would send them straight back to this invite on its next mount.
    await clearPendingInvite();
    router.replace(params ? { pathname: '/beeline/community', params } : '/beeline/community');
  }, []);
  const retry = () => {
    setError(null);
    setFailure(null);
    setLoading(true);
    setAttempt((value) => value + 1);
  };

  if (preview && step === 'you')
    return <YouStep onDone={() => { setStep('workspace'); if (joinAfterYou) void handleJoin(); }} />;

  return (
    <OnboardingFrame stage={2} testID="invite-join">
      {loading || (preview && joining && joinAfterYou) ? (
        <YStack alignItems="center" gap="4" paddingTop="8">
          <SurfaceGlyphLoader compact testID="invite-loader" />
          <T v="meta" color="secondary">Checking your invite…</T>
        </YStack>
      ) : preview ? (
        <>
          <Heading title="Where will you work?" />
          <Rise order={1}>
            <YStack gap="2">
              <T v="metaStrong" color="secondary">You’re invited</T>
              <ListItem
                padding="4" gap="3" borderRadius="lg" borderWidth={1} borderColor="needsYou" backgroundColor="raised"
                onPress={() => void handleJoin()} disabled={joining} accessibilityRole="button"
                aria-label={`Join ${preview.name}`} testID="confirm-community-join"
              >
                <IdentityMark avatarUrl={preview.avatar} kind="workspace" name={preview.name} seed={token ?? preview.name} size={44} />
                <YStack flex={1} minWidth={0} gap="1">
                  <T v="heading" testID="invite-title">{preview.name}</T>
                  <T v="meta" color="secondary" testID="invite-summary">
                    {inviteSummary(preview)}
                  </T>
                </YStack>
                <YStack paddingHorizontal="3" paddingVertical="2" borderRadius="full" backgroundColor="needsYou">
                  {joining ? <Spinner color="canvas" /> : <T v="metaStrong" color="canvas">Join</T>}
                </YStack>
              </ListItem>
              {error ? <Problem message={error} testID="invite-error" /> : null}
            </YStack>
          </Rise>
          <Rise order={2}>
            <YStack gap="5">
              <OrRule />
              <Choice icon={Sparkles} title="Create a workspace" line="Your own place for chats, agents and keys."
                onPress={() => void otherWay({ step: 'create' })} testID="invite-not-mine" />
            </YStack>
          </Rise>
        </>
      ) : failure === 'unreachable' ? (
        <YStack gap="4" testID="invite-unreachable">
          {error ? <Problem message={error} testID="invite-retry" /> :
            <Btn kind="quiet" label="Try invite again" onPress={retry} testID="invite-retry">Try invite again</Btn>}
          <Btn label="Choose another way in" onPress={() => void otherWay()} testID="invite-other-way">Choose another way in</Btn>
        </YStack>
      ) : (
        <YStack gap="4" testID="invite-unavailable">
          <Heading title="This invite doesn’t work anymore"
            line={`It may have expired, been used up, or been withdrawn. Ask for a new link, or start your own ${WORKSPACE_LABEL.toLowerCase()}.`} />
          <Btn label="Choose another way in" onPress={() => void otherWay()} testID="invite-other-way">Choose another way in</Btn>
        </YStack>
      )}
    </OnboardingFrame>
  );
}
