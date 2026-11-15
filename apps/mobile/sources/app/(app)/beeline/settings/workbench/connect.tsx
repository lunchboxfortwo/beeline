import { PageLoader } from '@/ui/PageLoader';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Card, XStack, YStack } from 'tamagui';
import * as WebBrowser from 'expo-web-browser';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useInstallObserver } from '@/buzz/use-observed-resource';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { useSharedWorkbench } from '@/buzz/workbench-surface';
import { connectorOfferCompletionRoute } from '@/buzz/connector-offer-ceremony';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import {
  squirePairingStages,
  connectorSetupErrorCopy,
  type ConnectorInstallState,
  type ConnectorInstallStep,
} from '@/buzz/workbench';
import { Btn, Copy, Section, T } from '@/ui/grammar';
import { ConnectorFooter, ConnectorFrame, ConnectorLoading, ConnectorNote, ConnectorRow } from '@/ui/screens/settings/connectors/ConnectorParts';
import { StepBar, StepDot, type ConnectBarPart, type ConnectStepState } from '@/ui/screens/settings/connectors/ConnectSteps';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** User-visible names for the remaining machine-level tool pairing flow. */
const CONNECTOR_NAMES: Record<string, string> = {
  'trusty-squire': 'Trusty Squire',
  tailscale: 'Tailscale',
};

function connectorNameFor(connectorId: string): string {
  return CONNECTOR_NAMES[connectorId] ?? connectorId;
}

/**
 * Connect a machine tool — one page for pairing, installation and the sign-in
 * hand-off: server-reported steps, a step bar, and the existing footer action.
 */
export default function ConnectTrustySquireScreen() {
  useLatencyRouteFrame('/beeline/settings/workbench/connect');
  const params = useLocalSearchParams<{ connectorId?: string | string[];
    workspaceId?: string | string[]; viewerId?: string | string[] }>();
  const connectorId = firstParam(params.connectorId);
  if (connectorId === 'google' || connectorId?.startsWith('google-'))
    return (
      <LegacyGoogleAppRedirect workspaceId={firstParam(params.workspaceId) ?? ''}
      viewerId={firstParam(params.viewerId) ?? ''} />);
  return <ConnectToolFlow />;
}

function LegacyGoogleAppRedirect({ workspaceId, viewerId }: { workspaceId: string; viewerId: string }) {
  useEffect(() => { router.replace({ pathname: '/beeline/settings/workbench/connect-app',
    params: { workspaceId, viewerId } } as Href); }, [workspaceId, viewerId]);
  return null;
}

/** One row of the connect stepper, already in the words the person reads. */
type StepView = { key: string; title: string; state: ConnectStepState; detail?: string; error?: boolean };

const SQUIRE_PHASE: Record<string, string> = {
  reach: 'Reaching', install: 'Installing', pair: 'Pairing', 'sign-in': 'Google sign-in',
};

/** The helper's own wording for an ended sign-in page never reaches the person. */
function stepReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  return /expired/i.test(reason) ? 'Sign-in closed before it finished. Try again.' : connectorSetupErrorCopy(reason);
}

/** The four Trusty Squire stages in the mock's words (Trusty Squire mock v3). */
function squireSteps(install: ConnectorInstallState | null, machine: string): StepView[] {
  const steps = install?.steps ?? [];
  const version = steps.map((step) => /^trusty-squire (\S+) installed$/i.exec(step.label.trim())?.[1]).find(Boolean);
  const stages = squirePairingStages(steps, machine, Boolean(install?.signIn));
  return stages.filter((stage) => stage.key !== 'other').map((stage) => {
    const failed = stage.status === 'failed';
    const reason = stepReason(stage.reason);
    if (stage.key === 'reach') {
      return { key: 'reach', title: `Reach ${machine}`,
        state: stage.status === 'done' ? 'done' : failed ? 'failed' : 'current',
        detail: stage.status === 'done' ? 'Helper online'
          : failed ? reason ?? `${machine} could not be reached. Check it is on and online.`
            : 'Waiting for the helper' };
    }
    const state: ConnectStepState = stage.status === 'done' ? 'done' : stage.status === 'failed' ? 'failed'
      : stage.status === 'pending' ? 'todo'
        : stage.key === 'sign-in' ? (install?.signIn ? 'waiting' : 'current') : 'current';
    if (stage.key === 'install') {
      return { key: 'install', title: 'Install Trusty Squire', state,
        detail: state === 'failed' ? reason : version ? `Version ${version}` : 'Latest version' };
    }
    if (stage.key === 'pair') {
      return { key: 'pair', title: 'Pair to this workspace', state,
        detail: state === 'failed' ? reason : state === 'done' ? 'Paired'
          : state === 'current' ? 'Pairing… usually under 10 seconds' : `Links ${machine} to this workspace` };
    }
    return { key: 'sign-in', title: 'Sign in to Google', state,
      detail: state === 'failed' ? reason : `Opens a secure browser on ${machine}` };
  });
}

/** Any other connector's own steps: the running (or first unfinished) one is current. */
function genericSteps(steps: readonly ConnectorInstallStep[], signInOpen: boolean): StepView[] {
  const failed = steps.some((step) => step.status === 'failed');
  let current = failed || steps.some((step) => step.status === 'active');
  return steps.map((step, index) => {
    const pendingCurrent = step.status === 'pending' && !current ? (current = true) : false;
    const state: ConnectStepState = step.status === 'done' ? 'done' : step.status === 'failed' ? 'failed'
      : step.status === 'active' || pendingCurrent ? (signInOpen && index === steps.length - 1 ? 'waiting' : 'current') : 'todo';
    return { key: `${index}`, title: step.label, state,
      ...(step.reason ? { detail: stepReason(step.reason) } : {}) };
  });
}

function ConnectToolFlow() {
  const params = useLocalSearchParams<{
    workspaceId?: string | string[];
    viewerId?: string | string[];
    connectorId?: string | string[];
    pairedConnectorId?: string | string[];
    offerId?: string | string[];
    roomId?: string | string[];
    helperId?: string | string[];
  }>();
  const workspaceId = firstParam(params.workspaceId) ?? '';
  const viewerId = firstParam(params.viewerId) ?? '';
  const connectorId = firstParam(params.connectorId) ?? 'trusty-squire';
  const pairedConnectorId = firstParam(params.pairedConnectorId);
  const offerId = firstParam(params.offerId);
  const roomId = firstParam(params.roomId);
  const requestedHelperId = firstParam(params.helperId)
    ?? (pairedConnectorId?.startsWith('squire:') ? pairedConnectorId.slice(7) : undefined);
  const offerCeremony = Boolean(offerId && pairedConnectorId && roomId);
  const squire = connectorId === 'trusty-squire';
  const { value: workbench, error: helperLoadError } = useSharedWorkbench(
    offerCeremony ? null : { workspaceId, viewerId });
  const helpers = workbench?.helpers ?? null;
  const [install, setInstall] = useState<ConnectorInstallState | null>(null);
  const [selectedHelperName, setSelectedHelperName] = useState<string | null>(null);
  const [errorCause, setError] = useState<string | null>(null);
  const error = errorCause ? connectorSetupErrorCopy(errorCause) : null;
  const [observedId, setObservedId] = useState(pairedConnectorId);
  const observed = useInstallObserver(workspaceId, observedId);
  useEffect(() => { if (pairedConnectorId) setObservedId(pairedConnectorId); }, [pairedConnectorId]);
  const pairedHelperRef = useRef<string | null>(pairedConnectorId?.startsWith('squire:') ? pairedConnectorId.slice(7) : null);
  const autoPairRef = useRef(false);

  const stopObserving = useCallback(() => setObservedId(undefined), []);
  const startObserving = useCallback((id: string) => {
    setObservedId(id);
    if (id === observedId) observed.retry();
  }, [observedId, observed.retry]);
  useEffect(() => {
    if (!observed.data) return;
    setInstall(observed.data);
    if (!observed.data.connected) return;
    router.replace((roomId || !squire ? connectorOfferCompletionRoute(roomId)
      : { pathname: '/beeline/settings/workbench/service', params: { workspaceId, viewerId, service: 'trusty-squire' } }) as Href);
  }, [observed.data, roomId, squire, viewerId, workspaceId]);
  useEffect(() => { if (observed.error) setError(observed.error); }, [observed.error]);

  const pair = useCallback(
    async (helperId: string) => {
      stopObserving();
      setError(null);
      setInstall(null);
      pairedHelperRef.current = helperId;
      setSelectedHelperName(helpers?.find((helper) => helper.id === helperId)?.name ?? null);
      try {
        const { connectorId: pairedConnectorId } = await getWorkbenchSource().pairConnector({
          workspaceId,
          connectorId,
          helperId,
        });
        startObserving(pairedConnectorId);
      } catch (cause) {
        setError(appErrorCopy(cause, 'Pairing failed'));
      }
    },
    [connectorId, helpers, startObserving, stopObserving, workspaceId],
  );

  useEffect(() => {
    // A pairing already under way is observed, never started again.
    if (offerCeremony || pairedConnectorId || autoPairRef.current || helpers === null || pairedHelperRef.current) return;
    const online = helpers.filter((helper) => helper.online);
    const requested = online.find((helper) => helper.id === requestedHelperId);
    if (requested) {
      autoPairRef.current = true;
      void pair(requested.id);
      return;
    }
    if (requestedHelperId || online.length !== 1) return;
    autoPairRef.current = true;
    void pair(online[0]!.id);
  }, [helpers, offerCeremony, pair, pairedConnectorId, requestedHelperId]);

  const retryPairing = useCallback(() => {
    setError(null);
    stopObserving();
    setInstall(null);
    if (offerId) {
      void monolithPhoneOperation('acceptConnectorOffer', { offerId })
        .then((accepted) => {
          if (accepted.status !== 'accepted') startObserving(accepted.connectorId);
        })
        .catch((cause) => {
          setError(appErrorCopy(cause, 'Pairing failed'));
        });
      return;
    }
    const helperId = pairedHelperRef.current ?? requestedHelperId;
    if (helperId) {
      autoPairRef.current = true;
      void pair(helperId);
    }
  }, [observed.error, observed.installMissing, observed.retry, offerId, pair, requestedHelperId, startObserving, stopObserving]);

  const connectorName = connectorNameFor(connectorId);
  const requestedHelper = helpers?.find((helper) => helper.id === requestedHelperId);
  const machineName = install?.helperName ?? selectedHelperName ?? requestedHelper?.name ?? 'your computer';
  const noHelpers = !requestedHelperId && !pairedHelperRef.current && helpers !== null && helpers.every((helper) => !helper.online);
  const onlineHelpers = helpers?.filter((helper) => helper.online) ?? [];
  // A choice exists only while nothing was named or paired yet.
  const choosing = !offerCeremony && !requestedHelperId && !pairedHelperRef.current && onlineHelpers.length > 1;
  const showSteps = offerCeremony || Boolean(requestedHelperId || pairedHelperRef.current || install);

  const counted = squire ? squireSteps(install, machineName)
    : genericSteps(install?.steps ?? [], Boolean(install?.signIn));
  // A failed request or read stops the step it was on and says why there.
  const stoppedAt = counted.findIndex((step) => step.state !== 'done');
  const shown = error && !counted.some((step) => step.state === 'failed') && stoppedAt >= 0
    ? counted.map((step, index) => index === stoppedAt ? { ...step, state: 'failed' as const, detail: connectorSetupErrorCopy(error), error: true } : step)
    : counted;
  const failedIndex = shown.findIndex((step) => step.state === 'failed');
  const activeIndex = failedIndex >= 0 ? failedIndex
    : shown.findIndex((step) => step.state === 'current' || step.state === 'waiting');
  const stepNumber = activeIndex >= 0 ? activeIndex + 1 : shown.length;
  const parts: ConnectBarPart[] = shown.map((_, index) => index < stepNumber - 1 ? 'filled'
    : index === stepNumber - 1 ? (failedIndex >= 0 ? 'failed' : activeIndex >= 0 ? 'active' : 'filled') : 'empty');
  // An error with no step to stop (no steps reported yet) still ends the run visibly.
  const errorUnplaced = Boolean(error) && !shown.some((step) => step.error);
  const failed = failedIndex >= 0 || errorUnplaced;
  const signInReady = !failed && Boolean(install?.signIn);
  const openSignIn = () => {
    const signIn = install?.signIn;
    if (!install || !signIn) return;
    if (signIn.method === 'oauth') {
      void WebBrowser.openBrowserAsync(signIn.url)
        .then(() => observed.retry())
        .catch(cause => setError(appErrorCopy(cause, 'Sign-in could not open')));
      return;
    }
    router.push({
      pathname: '/beeline/settings/workbench/connect-signin' as never,
      params: {
        workspaceId,
        viewerId,
        // The paired ROW id, so the overlay observes this
        // machine's connector — not any row of the type.
        connectorId: install.connectorId,
        connectorName,
        machineName,
        url: signIn.url,
        method: signIn.method,
        ...(offerId ? { offerId } : {}),
        ...(roomId ? { roomId } : {}),
      },
    });
  };
  const signInLabel = squire ? 'Sign in to Google' : `Sign in to ${connectorName}`;

  return (
    <ConnectorFrame title={showSteps && squire ? `Connect ${machineName}` : connectorName} back={() => router.back()}
      backLabel={`Back to ${connectorName}`} scrollTestID="connect-scroll"
      footer={showSteps ? <ConnectorFooter>
        {failed ? (
          <>
            <Btn kind="primary" label="Try again" onPress={retryPairing} testID="connect-retry">{'Try again'}</Btn>
            <ConnectorNote testID="connect-foot-note">
              {failedIndex <= 0 ? `Sign in unlocks once ${machineName} answers.` : 'Sign in unlocks when pairing finishes.'}
            </ConnectorNote>
          </>
        ) : (
          <>
            <Btn kind="primary" label={signInLabel} disabled={!signInReady} accessibilityState={{ disabled: !signInReady }}
              onPress={signInReady ? openSignIn : () => undefined} testID="connect-sign-in">{signInLabel}</Btn>
            <ConnectorNote testID="connect-foot-note">
              {signInReady ? install?.signIn?.method === 'oauth'
                ? 'Opens sign-in in your browser.'
                : `Opens ${machineName}’s secure browser. About a minute.` : 'Unlocks when pairing finishes.'}
            </ConnectorNote>
          </>
        )}
      </ConnectorFooter> : undefined}>
      {helpers === null && !helperLoadError && !offerCeremony && !showSteps ? (
        <ConnectorLoading testID="connect-loading" label="Looking for your machine…"><PageLoader testID="connect-loader" /></ConnectorLoading>
      ) : null}
      {noHelpers && !offerCeremony ? (
        <YStack gap="3" testID="connect-no-helper">
          <ConnectorNote>
            Squire runs on a helper. Every agent on that helper can use its connections, within the grants you set.
          </ConnectorNote>
          <YStack alignItems="center" paddingVertical="4"><Copy testID="connect-no-helper-empty">No online helpers found</Copy></YStack>
          <Card backgroundColor="raised" borderWidth={1} borderColor="stroke" padding="4" gap="2" testID="connect-no-helper-command">
            <T v="code">npx usebeeline connect</T>
            <ConnectorNote>
              Run this on the machine you want to hold your keys. When it appears here, come back
              and pair it.
            </ConnectorNote>
          </Card>
        </YStack>
      ) : null}
      {choosing ? (
        <YStack gap="2" testID="connect-machine-picker">
          <Section title="Helpers">
            {onlineHelpers.map((helper, n) => (
              <ConnectorRow key={helper.id} title={helper.name} description="online" action="pair" onPress={() => void pair(helper.id)}
                last={n === onlineHelpers.length - 1} testID={`connect-machine-${helper.id}`} />
            ))}
          </Section>
          <ConnectorNote>Choose the machine that will hold your keys.</ConnectorNote>
        </YStack>
      ) : null}
      {showSteps ? (
        <YStack gap="4" testID="connect-install-progress">
          <YStack gap="2">
            <XStack justifyContent="space-between" gap="2">
              <T v="metaStrong" testID="connect-progress-count">Step {stepNumber} of {shown.length}</T>
              {squire && activeIndex >= 0 ? (
                <T v="meta" color="secondary">
                  {shown[activeIndex]!.key === 'reach' ? `Reaching ${machineName}` : SQUIRE_PHASE[shown[activeIndex]!.key]}
                </T>
              ) : null}
            </XStack>
            <StepBar parts={parts} testID="connect-step-bar" />
          </YStack>
          {shown.map((step, index) => (
            <XStack key={step.key} gap="3" testID={`connect-step-${index}-${step.state}`}>
              <StepDot number={index + 1} state={step.state} testID={`connect-step-${index}-dot`} />
              <YStack flex={1} minWidth={0} gap="1" paddingTop="0.5">
                <Copy quiet={step.state === 'todo'}>{step.title}</Copy>
                {step.detail ? (
                  <T v="meta" color={step.state === 'failed' ? 'removed' : step.state === 'current' ? 'needsYou' : 'secondary'}
                    testID={step.error ? 'connect-error' : `connect-step-${index}-detail`}>
                    {step.detail}
                  </T>
                ) : null}
              </YStack>
            </XStack>
          ))}
        </YStack>
      ) : null}
      {errorUnplaced ? <ConnectorNote tone="danger" testID="connect-error">{error ?? ''}</ConnectorNote> : null}
    </ConnectorFrame>
  );
}
