import React from 'react';
import { Clipboard, FileText, Image as Photo } from 'lucide-react-native';
import { Glyph, SheetFrame, SheetRow } from '@/ui/grammar';

type AttachmentPickerSheetProps = {
  visible: boolean;
  onClose: () => void;
  onPickDocument: () => void;
  onPickPhoto: () => void;
  onPickPasted?: () => void;
};

/** The composer's +: Photos, Files and (where the platform can) Paste from clipboard. */
export function AttachmentPickerSheet({
  visible,
  onClose,
  onPickDocument,
  onPickPhoto,
  onPickPasted,
}: AttachmentPickerSheetProps) {
  // The sheet is drawn in-app (no native modal), so a native picker can open at once.
  const choose = (action: () => void) => {
    onClose();
    action();
  };
  return (
    <SheetFrame open={visible} close={onClose} title="Attach" testID="attachment-picker-sheet">
      <SheetRow
        icon={<Glyph icon={Photo} />}
        label="Photos"
        detail="Choose up to 10"
        onPress={() => choose(onPickPhoto)}
        testID="attachment-picker-photo"
      />
      <SheetRow
        icon={<Glyph icon={FileText} />}
        label="Files"
        detail="Preserve original"
        onPress={() => choose(onPickDocument)}
        testID="attachment-picker-document"
      />
      {onPickPasted && (
        <SheetRow
          icon={<Glyph icon={Clipboard} />}
          label="Paste from clipboard"
          onPress={() => choose(onPickPasted)}
          testID="attachment-picker-paste"
        />
      )}
    </SheetFrame>
  );
}
