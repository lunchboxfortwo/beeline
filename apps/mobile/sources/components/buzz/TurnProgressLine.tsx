import React, { useEffect, useState } from 'react';
import { ListItem, ScrollView, Spinner, XStack, YStack } from 'tamagui';
import { T } from '@/ui/grammar';
import { IdentityMark } from './IdentityMark';
import { Button } from './Button';
import type { ComposerWorkingAgent } from '@/buzz/room-indicators';
import { BeelineMarkSpinner } from './BeelineMarkSpinner';
import { TURN_LINE_ROW_MIN_HEIGHT } from '@/buzz/room-bottom-chrome';
import { SPINNER_STEP_MS, elapsedSeconds, formatWorkingCounter } from '@/buzz/turn-clock';
import { TurnBandSlot, TurnLineBar } from './TurnLineFrame';

export { TurnBandSlot };

/** The stop word sits in the row's own height; hit slop makes up the 44pt target. */
export const STOP_HIT_SLOP = (44 - TURN_LINE_ROW_MIN_HEIGHT) / 2;
const SLOP = { top: STOP_HIT_SLOP, bottom: STOP_HIT_SLOP, left: 8, right: 8 };

/**
 * The status line (decision 16): one small line above the composer while an
 * agent works — a spinner, "Jimmy thinking…" in brass, and a plain Stop for
 * the person who may withdraw the question. "Name · starting…" is the
 * explicit helper startup phase; nothing shows when idle. It reports a turn
 * and goes nowhere; Stop is the one action a turn in progress admits. A press
 * is acknowledged here (Stop dims) before the cancelled receipt lands; a
 * failed stop enables it again. The elapsed counter ticks from the server
 * receipt's own time; without a receipt time no interval is scheduled.
 */
export function TurnProgressLine(props: React.ComponentProps<typeof TurnProgressLineBody> & {
  /** Accepted external sends use the same line without live motion. */
  live?: boolean;
}) {
  // A stream replaces its parent's Stop closure on every tick. Keep the paint
  // boundary stable while the action reads the latest committed turn.
  const stopRef = React.useRef(props.onStop);
  React.useLayoutEffect(() => {
    stopRef.current = props.onStop;
  });
  const stop = React.useCallback(() => stopRef.current?.(), []);
  return props.live === false && !props.onStop ? (
    <TurnSettledLine line={props.label} inset={props.inset} leading testID={props.testID} />
  ) : (
    <TurnProgressLineBody {...props} onStop={props.onStop ? stop : undefined} />
  );
}

const TurnProgressLineBody = React.memo(function TurnProgressLineBody({
  label,
  live = true,
  startedAt,
  received = false,
  onStop,
  stopping = false,
  testID,
  inset = true,
  agents,
  onStopAgent,
}: {
  agents?: readonly ComposerWorkingAgent[];
  onStopAgent?: (stop: { agentPubkey: string; requestId: string }) => Promise<boolean>;
  label: string;
  live?: boolean;
  /** Desktop callers already supply the transcript inset around this row. */
  inset?: boolean;
  /** Server receipt time, unix seconds, the elapsed counter ticks from. */
  startedAt?: number;
  /** A new human steer was committed against this running turn. */
  received?: boolean;
  /** Present only for someone who may act in the Room; absent renders no control. */
  onStop?: () => void;
  /** The asker already pressed stop; the cancelled receipt has not landed yet. */
  stopping?: boolean;
  testID?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [stoppingAgents, setStoppingAgents] = useState<ReadonlySet<string>>(new Set());
  const stopAgent = async (agent: ComposerWorkingAgent) => {
    if (!agent.stop || !onStopAgent) return;
    const key = `${agent.pubkey}:${agent.stop.requestId}`;
    setStoppingAgents(current => new Set(current).add(key));
    const success = await onStopAgent(agent.stop);
    if (!success) setStoppingAgents(current => { const next = new Set(current); next.delete(key); return next; });
  };
  const group = agents && agents.length > 1 ? agents : undefined;
  useEffect(() => { setExpanded(false); setStoppingAgents(new Set()); }, [group?.map(agent => `${agent.pubkey}:${agent.stop?.requestId}`).join(',')]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    const tick = () => {
      const next = Date.now();
      setNow((previous) =>
        elapsedSeconds(startedAt * 1_000, previous) === elapsedSeconds(startedAt * 1_000, next) ? previous : next,
      );
    };
    tick();
    const timer = setInterval(tick, SPINNER_STEP_MS);
    return () => clearInterval(timer);
  }, [startedAt]);
  const counter = startedAt != null ? formatWorkingCounter(startedAt * 1_000, now, stopping ? 'stopping' : 'thinking') : undefined;
  const stateLabel = [counter, received ? 'received' : undefined].filter(Boolean).join(' · ');
  const workingAvatars = agents?.length ? (
    <XStack alignItems="center" flexShrink={0}>
      {agents.slice(0, 3).map((agent, index) => <YStack key={agent.pubkey} width={index === Math.min(agents.length, 3) - 1 ? 24 : 16} flexShrink={0}
        borderWidth={2} borderColor="canvas" borderRadius="sm">
        <IdentityMark kind="agent" seed={agent.pubkey} name={agent.name} avatarUrl={agent.avatar} face={agent.face} size={20} />
      </YStack>)}
      {agents.length > 3 ? <T v="meta" color="secondary" marginLeft="1">+{agents.length - 3}</T> : null}
    </XStack>
  ) : null;
  return (
    <TurnLineBar
      inset={inset}
      accessibilityLabel={stateLabel ? `${label} (${stateLabel})` : label}
      accessibilityLiveRegion="polite"
      accessibilityRole={group ? undefined : live ? 'progressbar' : 'text'}
      testID={testID}
    >
      {group && expanded ? (
        <YStack position="absolute" bottom="100%" left="4" right="4" maxHeight={280}
          backgroundColor="raised" borderWidth={1} borderColor="stroke" borderRadius="lg" testID="working-agents-list">
          <ScrollView>
            {group.map(agent => {
              const busy = stoppingAgents.has(`${agent.pubkey}:${agent.stop?.requestId}`);
              return <XStack key={agent.pubkey} paddingHorizontal="3" minHeight={44} gap="2" alignItems="center">
                <IdentityMark kind="agent" seed={agent.pubkey} name={agent.name} avatarUrl={agent.avatar} face={agent.face} size={24} />
                <T v="meta" flex={1}>{agent.name}</T>
                <T v="meta" color="secondary">{formatWorkingCounter(agent.startedAt * 1_000, now, busy ? 'stopping' : 'thinking')}</T>
                {agent.stop && onStopAgent ? <Button size="inline" variant="quiet" alignSelf="center" label="Stop" disabled={busy}
                  accessibilityLabel={`Stop ${agent.name}`} onPress={() => void stopAgent(agent)} testID={`stop-agent-${agent.pubkey}`} /> : null}
              </XStack>;
            })}
          </ScrollView>
        </YStack>
      ) : null}
      <XStack height={TURN_LINE_ROW_MIN_HEIGHT} minWidth={0} gap="2" alignItems="center">
        <YStack testID={testID ? `${testID}-glyph` : undefined}>
          {live ? <Spinner size="small" color="needsYou" scale={0.7} /> : <BeelineMarkSpinner />}
        </YStack>
        {group ? (
          <ListItem flex={1} minWidth={0} padding="0" minHeight={0} gap="2" backgroundColor="transparent"
            justifyContent="flex-start" onPress={() => setExpanded(value => !value)}
            aria-label={expanded ? 'Hide working agents' : 'Show working agents'} accessibilityRole="button"
            role="button" aria-expanded={expanded} hitSlop={SLOP} accessibilityState={{ expanded }} testID="working-agents-toggle">
            {workingAvatars}
            <T v="meta" color="secondary" numberOfLines={1} testID={testID ? `${testID}-label` : undefined}>{label}</T>
            {counter != null ? <T v="meta" color="secondary" flexShrink={0} testID={testID ? `${testID}-elapsed` : undefined}>{counter}</T> : null}
          </ListItem>
        ) : <>
        {workingAvatars}
        <XStack flex={1} minWidth={0} alignItems="center">
          <T v="meta" color="needsYou" numberOfLines={1} testID={testID ? `${testID}-label` : undefined}>{label}</T>
          {counter != null ? <T v="meta" color="needsYou" marginLeft="1" testID={testID ? `${testID}-elapsed` : undefined}>{counter}</T> : null}
          {received ? <T v="meta" color="needsYou" testID={testID ? `${testID}-received` : undefined}> · received</T> : null}
        </XStack>
        </>}
        {group?.some(agent => agent.stop) && onStopAgent ? <Button size="inline" variant="quiet" alignSelf="center"
          label={expanded ? 'Stop all' : 'Stop'} accessibilityLabel="Stop all working agents"
          disabled={group.every(agent => !agent.stop || stoppingAgents.has(`${agent.pubkey}:${agent.stop.requestId}`))}
          onPress={() => { for (const agent of group) if (!stoppingAgents.has(`${agent.pubkey}:${agent.stop?.requestId}`)) void stopAgent(agent); }}
          testID="stop-all-agents" /> : null}
        {onStop ? (
          <T
            v="meta"
            color="secondary"
            opacity={stopping ? 0.5 : 1}
            accessibilityRole="button"
            aria-label={stopping ? 'Stopping this turn' : 'Stop this turn'}
            accessibilityState={{ busy: stopping, disabled: stopping }}
            hitSlop={SLOP}
            onPress={stopping ? undefined : onStop}
            testID={testID ? `${testID}-stop` : undefined}
          >
            Stop
          </T>
        ) : null}
      </XStack>
    </TurnLineBar>
  );
});

/**
 * The one-line summary a finished turn leaves behind, briefly: the past-tense
 * verb, total seconds and the "done" stamp. Static, with the completed mark;
 * the screen clears it after a few seconds. A failed send uses it with Retry.
 */
export function TurnSettledLine({ line, testID, inset = true, leading = false, leadingGlyph = true, multiline = false, action }: {
  line: string;
  testID?: string;
  inset?: boolean;
  /** The external-send variant shares the thinking line's live region. */
  leading?: boolean;
  leadingGlyph?: boolean;
  /** Failed message reasons stay readable in the transcript. */
  multiline?: boolean;
  action?: { label: string; onPress(): void };
}) {
  return (
    <TurnLineBar inset={inset} accessibilityLabel={line} accessibilityLiveRegion={leading ? 'polite' : undefined} testID={testID}>
      <XStack height={multiline ? undefined : TURN_LINE_ROW_MIN_HEIGHT} minWidth={0}
        gap={action && !leadingGlyph ? '0' : '2'} alignItems={multiline ? "baseline" : "center"}>
        {leadingGlyph ? (
          <YStack testID={testID ? `${testID}-glyph` : undefined}><BeelineMarkSpinner /></YStack>
        ) : null}
        <T v="meta" color="needsYou" numberOfLines={multiline ? undefined : 1}
          flexShrink={multiline ? 1 : undefined} testID={testID ? `${testID}-line` : undefined}>{line}</T>
        {action ? (
          <XStack flexShrink={0} alignItems="baseline">
            <T v="meta" color="needsYou"> · </T>
            <T
              v="meta"
              color="needsYou"
              accessibilityRole="button"
              flexShrink={0}
              hitSlop={SLOP}
              onPressIn={(event: { stopPropagation(): void }) => event.stopPropagation()}
              onPress={(event: { stopPropagation(): void }) => { event.stopPropagation(); action.onPress(); }}
              testID={testID ? `${testID}-retry` : undefined}
            >
              {action.label}
            </T>
          </XStack>
        ) : null}
      </XStack>
    </TurnLineBar>
  );
}
