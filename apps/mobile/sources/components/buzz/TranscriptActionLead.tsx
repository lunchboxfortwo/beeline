import React from 'react';
import { YStack } from 'tamagui';
import { CornerDownRight, type LucideProps } from 'lucide-react-native';
import { HEIGHT, Inked, STEP } from '@/ui/grammar';
import { TRANSCRIPT_FACE_SIZE } from '@/ui/screens/transcript/TranscriptLine';

/** The ↳ size, in points. */
const SIZE = 13;
/** The ↳ draws its stem 4 units into its 24-unit box (`ThreadGlyph`). */
const STEM_X = (SIZE * 4) / 24;

/**
 * The leading slot of the transcript's opened-thread and added-to-backlog rows.
 * The ↳ stem sits on the center of the message faces above and below, and the
 * label starts on the message text column: the slot plus the row's gap
 * (`TranscriptNavigationRow`, gap 2) is the face column (`HEIGHT.control`).
 */
export function TranscriptActionLead() {
  return (
    <YStack
      testID="transcript-action-lead"
      width={HEIGHT.control - STEP['2']}
      paddingLeft={TRANSCRIPT_FACE_SIZE / 2 - STEM_X}
      alignItems="flex-start"
    >
      <Inked<LucideProps> glyph={CornerDownRight} color="secondary" size={SIZE} strokeWidth={1.7} />
    </YStack>
  );
}
