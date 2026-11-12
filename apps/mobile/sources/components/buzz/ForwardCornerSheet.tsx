import React from 'react';
import { HullDialog } from './HullDialog';

type ForwardCornerSheetProps = {
  onClose: () => void;
  onOpen: () => void;
  visible: boolean;
  fromMessage?: boolean;
};

/**
 * Shared new-thread prompt for the header and message swipe.
 * Message entry keeps the chosen message as the starting topic.
 */
export function ForwardCornerSheet({ onClose, onOpen, visible, fromMessage = true }: ForwardCornerSheetProps) {
  return (
    <HullDialog
      accessibilityLabel={'Close new thread prompt'}
      onRequestClose={onClose}
      body={fromMessage ? 'Start a new thread with the chosen message as the starting topic.' : 'Start a new thread in this chat.'}
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
