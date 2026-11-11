import React, { useEffect, useRef, useState } from 'react';
import { ListItem, Separator, Switch, XStack, YStack } from 'tamagui';
import { Archive, Lock } from 'lucide-react-native';
import { Btn, Copy, Glyph, HEIGHT, SheetFrame, T } from '@/ui/grammar';

/**
 * ⋯ on a thread (header B): Lock corner, Close corner, Cancel. Closing the
 * surface leaves a request running, but retires its navigation. The lock
 * value comes from the current server Room read.
 */
export function CornerActionsSheet({
  visible,
  title,
  locked,
  connected,
  onClose,
  closeCorner,
  setLocked,
  onClosed,
  onSaved,
  onError,
}: {
  visible: boolean;
  title: string;
  locked: boolean;
  connected: boolean;
  onClose: () => void;
  closeCorner: () => Promise<void>;
  setLocked: (locked: boolean) => Promise<void>;
  onClosed: () => void;
  onSaved: () => void;
  onError: (error: unknown) => void;
}) {
  const [closing, setClosing] = useState(false);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const savingRef = useRef(false);
  useEffect(() => {
    generation.current += 1;
    setClosing(false);
    pending.current = false;
    return () => {
      generation.current += 1;
    };
  }, [visible]);
  const dismiss = () => {
    generation.current += 1;
    onClose();
  };
  const close = async () => {
    if (pending.current) return;
    const attempt = generation.current;
    pending.current = true;
    setClosing(true);
    try {
      await closeCorner();
      if (attempt === generation.current) onClosed();
    } catch (error) {
      if (attempt === generation.current) onError(error);
    } finally {
      if (attempt === generation.current) {
        pending.current = false;
        // Accepted navigation takes priority over resetting its departing sheet.
        React.startTransition(() => setClosing(false));
      }
    }
  };
  const lockDisabled = closing || !connected || saving;
  const changeLock = async (value: boolean) => {
    if (savingRef.current || closing || !connected) return;
    const attempt = generation.current;
    savingRef.current = true;
    setSaving(true);
    try {
      await setLocked(value);
      if (attempt === generation.current) onSaved();
    } catch (error) {
      if (attempt === generation.current) onError(error);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <SheetFrame open={visible} close={dismiss} title={title} testID="corner-actions-sheet">
      <ListItem padding="0" paddingVertical="3" gap="3" alignItems="flex-start" backgroundColor="raised"
        minHeight={HEIGHT.sheetRow} disabled={lockDisabled} onPress={() => void changeLock(!locked)}
        aria-label="Lock corner" accessibilityRole="switch" accessibilityState={{ checked: locked, disabled: lockDisabled }}
        testID="lock-corner-action">
        <YStack paddingTop="0.5"><Glyph icon={Lock} size={18} /></YStack>
        <YStack flex={1} minWidth={0} gap="1">
          <Copy>Lock corner</Copy>
          <Copy small quiet>Stops agents from closing this corner, including after a merge. You can still close it.</Copy>
        </YStack>
        <Switch checked={locked} disabled={lockDisabled} onCheckedChange={(value: boolean) => void changeLock(value)}
          backgroundColor={locked ? 'needsYou' : 'highlight'} aria-label="Lock corner" testID="lock-corner-switch">
          <Switch.Thumb backgroundColor="ink" />
        </Switch>
      </ListItem>
      <Separator borderColor="stroke" />
      <ListItem padding="0" paddingVertical="3" gap="3" alignItems="flex-start" backgroundColor="raised"
        minHeight={HEIGHT.sheetRow} disabled={closing} onPress={() => void close()}
        aria-label="Close corner" accessibilityRole="button" testID="close-corner-action">
        <YStack paddingTop="0.5"><Glyph icon={Archive} size={18} /></YStack>
        <YStack flex={1} minWidth={0} gap="1">
          <T v="heading" color="removed">{closing ? 'Closing corner…' : 'Close corner'}</T>
          <Copy small quiet>Ends the edit session and archives this corner. Unmerged work is lost.</Copy>
        </YStack>
      </ListItem>
      <XStack paddingTop="2">
        <Btn kind="secondary" label="Cancel" flex={1} minHeight={HEIGHT.primary} onPress={dismiss} testID="corner-actions-close">Cancel</Btn>
      </XStack>
    </SheetFrame>
  );
}
