import React from 'react';
import { HullDialog } from './HullDialog';

type ForwardCornerSheetProps = {
  onClose: () => void;
  onOpen: () => void;
  visible: boolean;
};

/**
 * Mobile swipe-right on a message asks whether to open a new thread from it.
 * The prompt says the chosen message becomes the starting topic.
 */
export function ForwardCornerSheet({ onClose, onOpen, visible }: ForwardCornerSheetProps) {
  return (
    <HullDialog
      accessibilityLabel={'Close new thread prompt'}
      onRequestClose={onClose}
      body={'Start a new thread with the chosen message as the starting topic.'}
      testID="forward-corner-sheet"
      title={'Begin a new thread'}
      visible={visible}
      actions={[
        { label: 'Cancel', onPress: onClose, testID: 'forward-corner-cancel' },
        {
          label: 'Open thread',
          onPress: onOpen,
          variant: 'primary',
          testID: 'forward-corner-open',
        },
      ]}
    />
  );
}
