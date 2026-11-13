import { useTextDraft } from '@/buzz/use-text-draft';
import React, { useEffect, useState } from 'react';
import { ScrollView, XStack, YStack } from 'tamagui';
import { T } from '@/ui/grammar';
import { HullDialogActions, HullDialogInput } from './HullDialog';
import { HullActionSheetModal } from './HullActionSheet';

const CLOSING_TIMES = [
  { label: '5 min', seconds: 300 },
  { label: '15 min', seconds: 900 },
  { label: '1 hour', seconds: 3600 },
  { label: '4 hours', seconds: 14400 },
  { label: '1 day', seconds: 86400 },
] as const;

export type PollDraft = {
  prompt: string;
  options: { label: string; consequence: string }[];
  ttlSeconds: number;
};

export function CreatePollSheet({
  visible,
  draftContext = 'global',
  busy,
  onClose,
  onCreate,
}: {
  visible: boolean;
  draftContext?: string;
  busy: boolean;
  onClose: () => void;
  onCreate: (draft: PollDraft) => Promise<boolean>;
}) {
  const [prompt, setPrompt, promptDraft] = useTextDraft(`poll:${draftContext}:prompt`, '');
  const [options, setOptions, optionsDraft] = useTextDraft(`poll:${draftContext}:options`, ['', '']);
  const [ttlSeconds, setTtlSeconds] = useState<number>(3600);
  useEffect(() => {
    if (!visible) {
      setTtlSeconds(3600);
    }
  }, [visible]);
  const ready =
    prompt.trim().length > 0 &&
    prompt.trim().length <= 120 &&
    options.length >= 2 &&
    options.every((option) => option.trim().length > 0 && option.trim().length <= 32);
  return (
    <HullActionSheetModal
      visible={visible}
      onClose={busy ? () => undefined : onClose}
      dismissOnBackdrop={!busy}
      scrollBody={false}
      title="Create poll"
      testID="create-poll-sheet"
      footer={
        <HullDialogActions
          paddingHorizontal="6"
          paddingTop="4"
          paddingBottom="2"
          actions={[
            { label: 'Cancel', disabled: busy, onPress: onClose },
            {
              label: 'Create poll',
              variant: 'primary',
              disabled: busy || !ready,
              busy,
              testID: 'create-poll-submit',
              onPress: async () => {
                const clearPrompt = promptDraft.capture();
                const clearOptions = optionsDraft.capture();
                const succeeded = await onCreate({
                  prompt: prompt.trim(),
                  options: options.map((option) => ({
                    label: option.trim(),
                    consequence: option.trim(),
                  })),
                  ttlSeconds,
                });
                if (succeeded) {
                  clearPrompt();
                  clearOptions();
                }
              },
            },
          ]}
        />
      }
    >
      <ScrollView keyboardShouldPersistTaps="handled" maxHeight={470} paddingHorizontal="6">
        <T v="metaStrong" marginTop="4" marginBottom="2">Question</T>
        <HullDialogInput
          value={prompt}
          onChangeText={setPrompt}
          placeholder="What should we decide?"
          maxLength={120}
          testID="create-poll-question"
        />
        <T v="metaStrong" marginTop="4" marginBottom="2">Options</T>
        {options.map((option, index) => (
          <XStack key={index} alignItems="center" gap="2">
            <T v="body" width={18}>{String.fromCharCode(65 + index)}</T>
            <YStack flex={1}>
              <HullDialogInput
                value={option}
                onChangeText={(value) =>
                  setOptions((current) => current.map((item, i) => (i === index ? value : item)))
                }
                placeholder={`Option ${index + 1}`}
                maxLength={32}
                testID={`create-poll-option-${index}`}
              />
            </YStack>
            {options.length > 2 ? (
              <YStack
                accessibilityRole="button"
                accessibilityLabel={`Remove option ${index + 1}`}
                onPress={() => setOptions((current) => current.filter((_, i) => i !== index))}
                minHeight={44}
                justifyContent="center"
                cursor="pointer"
              >
                <T v="meta">Remove</T>
              </YStack>
            ) : null}
          </XStack>
        ))}
        {options.length < 4 ? (
          <YStack
            accessibilityRole="button"
            accessibilityLabel="Add option"
            onPress={() => setOptions((current) => [...current, ''])}
            testID="create-poll-add-option"
            minHeight={44}
            justifyContent="center"
            alignSelf="flex-start"
            cursor="pointer"
          >
            <T v="meta">Add option</T>
          </YStack>
        ) : null}
        <T v="metaStrong" marginTop="4" marginBottom="2">Closes after</T>
        <XStack flexWrap="wrap" gap="2" marginBottom="2">
          {CLOSING_TIMES.map((time) => (
            <YStack
              key={time.seconds}
              accessibilityRole="radio"
              accessibilityState={{ selected: ttlSeconds === time.seconds }}
              onPress={() => setTtlSeconds(time.seconds)}
              minHeight={44}
              minWidth={70}
              paddingHorizontal="2"
              justifyContent="center"
              alignItems="center"
              borderWidth={1}
              borderColor={ttlSeconds === time.seconds ? 'needsYou' : 'strongStroke'}
              borderRadius="sm"
              cursor="pointer"
            >
              <T v="meta">{time.label}</T>
            </YStack>
          ))}
        </XStack>
      </ScrollView>
    </HullActionSheetModal>
  );
}
