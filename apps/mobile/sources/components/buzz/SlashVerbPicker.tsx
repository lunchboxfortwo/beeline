import React from 'react';
import { ScrollView, YStack } from 'tamagui';
import { Slash } from 'lucide-react-native';
import { T } from '@/ui/grammar';
import type { BuiltInSlashVerb, BuiltInSlashVerbId } from '@/buzz/slash-verbs';
import type { AgentPaletteCommand } from '@/buzz/slash-verbs';
import { SuggestionCard, SuggestionGlyph, SuggestionRow } from '@/ui/screens/composer/Suggestions';

/** At most six rows show before the list scrolls inside the card. */
const VISIBLE_ROWS = 6;

export function SlashVerbPicker({
  verbs,
  query,
  highlightedIndex,
  onDismiss,
  onSelect,
  /** The addressed agent's advertised commands; rendered above Beeline's built-ins. */
  commands,
  /** Display name of the agent whose commands these are (heading attribution). */
  agentName,
  /** True once the agent's published list resolved empty or absent: quiet honesty line. */
  agentLacksCommands,
  onSelectCommand,
}: {
  verbs: readonly BuiltInSlashVerb[];
  /** The slash token currently typed, without the leading `/` ('' when open on just '/'). */
  query: string;
  /** Highlight index over the COMBINED list: advertised commands first, then built-in verbs. */
  highlightedIndex: number;
  onDismiss: () => void;
  onSelect: (id: BuiltInSlashVerbId) => void;
  commands?: readonly AgentPaletteCommand[];
  agentName?: string;
  agentLacksCommands?: boolean;
  onSelectCommand: (name: string) => void;
}) {
  const commandCount = commands?.length ?? 0;
  return (
    <SuggestionCard
      title={agentName ? `Commands · ${agentName}` : 'Commands'}
      label="Available commands"
      testID="slash-verb-picker"
      onDismiss={onDismiss}
      dismissTestID="slash-verb-dismiss"
    >
      {commandCount > 0 || verbs.length > 0 ? (
        <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} maxHeight={VISIBLE_ROWS * 56}>
          {agentLacksCommands && commandCount === 0 ? (
            <YStack paddingVertical="2" testID="slash-agent-no-commands">
              <T v="meta" color="secondary" numberOfLines={2}>
                {agentName
                  ? `${agentName} does not advertise commands`
                  : 'This agent does not advertise commands'}
              </T>
            </YStack>
          ) : null}
          {(commands ?? []).map((command, index) => (
            <SuggestionRow
              key={`command:${command.name}`}
              first={index === 0 && !(agentLacksCommands && commandCount === 0)}
              selected={index === highlightedIndex}
              label={`/${command.name}. ${command.description ?? 'Advertised command'}`}
              role={command.toggle === undefined ? 'button' : 'switch'}
              state={
                command.toggle === undefined
                  ? { selected: index === highlightedIndex }
                  : { selected: index === highlightedIndex, checked: command.toggle }
              }
              onPress={() => onSelectCommand(command.name)}
              testID={`slash-agent-command-${command.name}`}
              mark={<SuggestionGlyph icon={Slash} />}
              name={`/${command.name}`}
              detail={[command.description, command.inputHint].filter(Boolean).join(' · ') || undefined}
              trailing={command.toggle === undefined ? undefined : (
                <T v="metaStrong" color={command.toggle ? 'needsYou' : 'secondary'} testID={`slash-agent-command-${command.name}-state`}>
                  {command.toggle ? 'On' : 'Off'}
                </T>
              )}
            />
          ))}
          {verbs.map((verb, verbIndex) => {
            const index = commandCount + verbIndex;
            return (
              <SuggestionRow
                key={verb.id}
                first={index === 0}
                selected={index === highlightedIndex}
                label={`/${verb.command}. ${verb.description}`}
                state={{ selected: index === highlightedIndex }}
                onPress={() => onSelect(verb.id)}
                testID={`slash-verb-${verb.id}`}
                mark={<SuggestionGlyph icon={Slash} />}
                name={`/${verb.command} · ${verb.label}`}
                detail={verb.description}
              />
            );
          })}
        </ScrollView>
      ) : (
        // An unrecognized verb is a named dead end: sending anyway passes the
        // text to the agent as an ordinary message.
        <YStack gap="1" paddingVertical="2" testID="slash-verb-no-match">
          <T v="metaStrong" color="ink">
            {query ? `/${query} is not a Beeline command` : 'No matching commands'}
          </T>
          <T v="meta" color="secondary">
            Beeline runs its commands from this menu. Send your text anyway to pass it to the agent
            as an ordinary message.
          </T>
        </YStack>
      )}
    </SuggestionCard>
  );
}
