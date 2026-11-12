import { EmptyState } from './EmptyState';
import { IndexRow } from './IndexRow';
import React from 'react';
import { YStack } from 'tamagui';
import { RoomGlyph } from '@/components/buzz/RoomGlyph';

export type EmptyLedgerVariant = 'room' | 'corner' | 'dm';

export type EmptyLedgerStarterPrompt = {
  /** The verb, in brass: "Ask an agent". */
  lead: string;
  /** What it is for: "to turn an idea into a plan". */
  detail: string;
  onPress: () => void;
  testID?: string;
};

type EmptyLedgerStateProps = {
  variant: EmptyLedgerVariant;
  name?: string;
  agentHandle?: string;
  onPress: () => void;
  /** A Room the viewer can write in, empty: teach by doing (first Room). */
  starterPrompts?: readonly EmptyLedgerStarterPrompt[];
  /** The line under the starter title (`roomStarterIntro`). */
  starterIntro?: string;
  testID?: string;
};

function emptyLedgerCopy(
  variant: EmptyLedgerVariant,
  name?: string,
  agentHandle?: string,
): { glyph: string | null; title: string; body: string } {
  if (variant === 'corner') {
    return {
      glyph: '△',
      title: agentHandle ? `Tag @${agentHandle.replace(/^@/, '')} to start` : 'Tag an agent to start',
      body: 'Agents here reply only when tagged.',
    };
  }
  if (variant === 'dm') {
    const person = name?.trim() || 'this person';
    return {
      glyph: '○',
      title: `Start with ${person}`,
      body: `Send ${person} the first message.`,
    };
  }
  return {
    glyph: null,
    title: 'Nothing in the log yet',
    body: 'Start with the work, question, or decision this chat is for.',
  };
}

/** Opening records are retained, but do not count as a conversation to start. */
export function cornerNeedsStarter(rows: readonly { systemEvent?: { kind?: string } }[]): boolean {
  return rows.every((row) =>
    row.systemEvent?.kind === 'corner-opened' || row.systemEvent?.kind === 'workflow-handoff',
  );
}

/** Shared empty-state copy and actions for Room, Corner and DM ledgers. */
export function EmptyLedgerState({
  variant,
  name,
  agentHandle,
  onPress,
  starterPrompts,
  starterIntro,
  testID = 'empty-ledger-state',
}: EmptyLedgerStateProps) {
  const copy = emptyLedgerCopy(variant, name, agentHandle);
  if (variant === 'room' && starterPrompts?.length) {
    return (
      <YStack flex={1} minHeight={44} alignItems="center" justifyContent="center" paddingHorizontal="6" paddingVertical="6" testID={testID}>
        <YStack width="100%" maxWidth={360} alignItems="center">
          <RoomGlyph size={28} />
          <EmptyState title={name ? `${name} is empty` : 'This chat is empty'} description={starterIntro} />
          <YStack alignSelf="stretch" gap="2" marginTop="6">
            {starterPrompts.map((prompt) => (
              <IndexRow key={prompt.lead} title={prompt.lead} description={prompt.detail} accessibilityLabel={`${prompt.lead} ${prompt.detail}`}
                onPress={prompt.onPress} testID={prompt.testID} />
            ))}
          </YStack>
        </YStack>
      </YStack>
    );
  }
  return (
    <YStack flex={1} minHeight={44} alignItems="center" justifyContent="center" paddingHorizontal="6" paddingVertical="6" testID={testID}>
      <EmptyState title={variant === 'corner' ? 'Nothing in the log yet' : copy.title} description={copy.body}
        action={{label:copy.title, onPress, accessibilityLabel:`${copy.title}. ${copy.body}`}} />
    </YStack>
  );
}
