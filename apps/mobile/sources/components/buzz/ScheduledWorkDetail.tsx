import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import React, { useState } from 'react';
import { YStack, XStack } from 'tamagui';
import { router } from 'expo-router';
import { workflowDisplayName } from '@/buzz/workflow-graph';
import { SettingsRow } from './SettingsRow';
import { ScheduledWorkWhere } from './ScheduledWorkWhere';
import { T } from '@/ui/grammar';

/**
 * The parts a schedule's or subscription's own page is built from, cut from the
 * workflow run page (`workflow-run.tsx`) so the three read as one family: its
 * hairline section head, its summary rail line, and the settings rows every
 * trigger detail page shares — When, Agent, Where, Does, then Stop.
 */
export function DetailSection({ title, testID }: { title: string; testID?: string }) {
  return (
    <XStack
      marginTop="2"
      paddingHorizontal="4"
      alignItems="center"
      justifyContent="space-between"
      borderBottomWidth={1}
      borderBottomColor="stroke"
      testID={testID}
    >
      <RoomListSectionHeader title={title} inset="content" spacing="flush"/>
    </XStack>
  );
}

/** The run page's summary line: a human rail beside quiet copy. */
export function DetailRailLine({ children, testID }: { children: React.ReactNode; testID?: string }) {
  return (
    <XStack alignItems="flex-start" marginHorizontal="4" marginVertical="4">
      <YStack position="absolute" left={-8} top={0} bottom={0} width={2} backgroundColor="needsYou" />
      <T v="meta" color="secondary" userSelect="text" flex={1} minWidth={0} testID={testID}>
        {children}
      </T>
    </XStack>
  );
}

/** When, Agent or Agents, and Where: the same three rows on every detail page. */
export function ScheduledWorkFacts({
  runs,
  agents,
  where,
  whereCorner,
  testID = 'scheduled-work-facts',
}: {
  runs: string;
  agents: readonly string[];
  where: string;
  whereCorner?: { id: string; name: string } | null;
  testID?: string;
}) {
  return (
    <YStack paddingHorizontal="2" testID={testID}>
      <SettingsRow description={runs} testID={`${testID}-when`} title="When" />
      <SettingsRow
        description={agents.length ? agents.map((name) => `@${name}`).join(', ') : 'None'}
        testID={`${testID}-agents`}
        title={agents.length > 1 ? 'Agents' : 'Agent'}
      />
      <SettingsRow description={where}
        descriptionContent={whereCorner ? <ScheduledWorkWhere corner={whereCorner} /> : undefined}
        testID={`${testID}-where`} title="Where" />
    </YStack>
  );
}

/** The same action rail for timer and event triggers. */
export function ScheduledWorkDoes({ roomId, prompt, workflowSlug }: {
  roomId: string;
  prompt: string;
  workflowSlug?: string;
}) {
  return (
    <>
      <DetailSection title="Does" testID="scheduled-work-does-header" />
      {workflowSlug ? (
        <>
          <YStack paddingHorizontal="2">
            <SettingsRow
              chevron="right"
              description="Workflow"
              onPress={() => router.push({ pathname: '/beeline/workflow', params: { roomId, name: workflowSlug } })}
              testID="scheduled-work-workflow"
              title={workflowDisplayName(workflowSlug)}
            />
          </YStack>
        </>
      ) : (
        <DetailRailLine testID="scheduled-work-prompt">{prompt}</DetailRailLine>
      )}
    </>
  );
}

/**
 * "Stop schedule" or "Stop subscription": one tap asks, a second confirms, the
 * same two steps the schedule list's STOP took. The confirm is the same row,
 * so the second tap lands where the first did; Cancel takes the trailing axis.
 */
export function StopScheduledWork({
  label,
  onStop,
  working,
  testID,
}: {
  label: string;
  onStop: () => void;
  working: boolean;
  testID: string;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <YStack paddingHorizontal="2">
      {confirming ? (
        <SettingsRow
          accessibilityLabel={`Confirm ${label.toLowerCase()}`}
          action="Cancel"
          disabled={working}
          onPress={onStop}
          testID={`${testID}-confirm`}
          title={label}
          tone="destructive"
          trailingPress={{
            accessibilityLabel: 'Cancel',
            disabled: working,
            onPress: () => setConfirming(false),
            testID: `${testID}-cancel`,
          }}
        />
      ) : (
        <SettingsRow
          disabled={working}
          onPress={() => setConfirming(true)}
          testID={testID}
          title={label}
          tone="destructive"
        />
      )}
    </YStack>
  );
}
