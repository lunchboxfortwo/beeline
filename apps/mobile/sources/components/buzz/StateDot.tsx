import React from 'react';
import { YStack } from 'tamagui';
import { Spinner } from '@/ui/grammar';

/**
 * StateDot — the ONE instrument dot (board revision 2's `.gind`): an 8px
 * circle beside a state word that makes the state scannable down a list.
 * The word is the signal; the dot is never the only carrier:
 *
 *   - `'live'`    filled with the theme's success token — a settled, good state;
 *   - `'pulse'`   work in flight: the one ring spinner, at the dot's row size;
 *   - `'failed'`  filled with the dialog-danger token — a broken state.
 */
export type StateDotKind = 'live' | 'pulse' | 'failed';

function Dot({ kind, testID }: { kind: Exclude<StateDotKind, 'pulse'>; testID?: string }) {
  return (
    <YStack
      width={8}
      height={8}
      borderRadius="full"
      flexShrink={0}
      backgroundColor={kind === 'live' ? 'added' : 'removed'}
      testID={testID}
    />
  );
}

export function StateDot({ kind, testID }: { kind: StateDotKind; testID?: string }) {
  if (kind !== 'pulse') return <Dot kind={kind} testID={testID ? `${testID}-${kind}` : undefined} />;
  return <Spinner size={12} testID={testID ? `${testID}-pulse` : undefined} />;
}
