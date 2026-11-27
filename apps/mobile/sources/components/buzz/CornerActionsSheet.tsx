import React, { useEffect, useRef, useState } from 'react';
import { ListItem, Separator, Switch, XStack, YStack } from 'tamagui';
import { Archive, Lock } from 'lucide-react-native';
import { Btn, Copy, Glyph, HEIGHT, SheetFrame, T, typeStyle, useTextSize } from '@/ui/grammar';

/**
 * ⋯ on a thread (header B): Lock thread, Close thread, Cancel. Closing the
 * surface leaves a request running, but retires its navigation. The lock
 * value comes from the current server Room read. A locked thread offers
 * Close only to a Workspace owner or admin (the server refuses anyone else).
 */
export function CornerActionsSheet({
  visible,
  title,
  locked,
  canManage,
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
  /** Workspace owner or admin: may close a locked thread. */
  canManage: boolean;
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
  const closeOffered = !locked || canManage;
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
  const textSize = useTextSize();
  const bodyLine = typeStyle('body', textSize).lineHeight;
  const headingLine = typeStyle('heading', textSize).lineHeight;
  const lockSlot = Math.max(28, bodyLine);
  return (
    <SheetFrame open={visible} close={dismiss} title={title} testID="corner-actions-sheet">
      {closeOffered && (
        <ListItem
          padding="0"
          paddingVertical="3"
          gap="3"
          alignItems="flex-start"
          backgroundColor="raised"
          minHeight={HEIGHT.sheetRow}
          disabled={lockDisabled}
          onPress={() => void changeLock(!locked)}
          aria-label="Lock thread"
          accessibilityRole="switch"
          accessibilityState={{ checked: locked, disabled: lockDisabled }}
          testID="lock-corner-action"
        >
          <YStack height={lockSlot} justifyContent="center">
            <Glyph icon={Lock} size={18} />
          </YStack>
          <YStack flex={1} minWidth={0} gap="1">
            <XStack alignItems="center">
              <YStack width={0} height={lockSlot} />
              <Copy>Lock thread</Copy>
            </XStack>
            <Copy small quiet>
              Stops agents and members from closing this thread, including after a merge. Admins can
              still close it.
            </Copy>
          </YStack>
          <YStack height={lockSlot} justifyContent="center">
            <Switch
              checked={locked}
              disabled={lockDisabled}
              onCheckedChange={(value: boolean) => void changeLock(value)}
              backgroundColor={locked ? 'needsYou' : 'highlight'}
              aria-label="Lock thread"
              testID="lock-corner-switch"
            >
              <Switch.Thumb backgroundColor="ink" />
            </Switch>
          </YStack>
        </ListItem>
      )}
      {closeOffered && <Separator borderColor="stroke" />}
      {closeOffered && (
        <ListItem
          padding="0"
          paddingVertical="3"
          gap="3"
          alignItems="flex-start"
          backgroundColor="raised"
          minHeight={HEIGHT.sheetRow}
          disabled={closing}
          onPress={() => void close()}
          aria-label="Close thread"
          accessibilityRole="button"
          testID="close-corner-action"
        >
          <YStack height={headingLine} justifyContent="center">
            <Glyph icon={Archive} size={18} />
          </YStack>
          <YStack flex={1} minWidth={0} gap="1">
            <T v="heading" color="removed">
              {closing ? 'Closing thread…' : 'Close thread'}
            </T>
            <Copy small quiet>
              Ends the edit session and archives this thread. Unmerged work is lost.
            </Copy>
          </YStack>
        </ListItem>
      )}
      <XStack paddingTop="2">
        <Btn
          kind="secondary"
          label="Cancel"
          flex={1}
          minHeight={HEIGHT.primary}
          onPress={dismiss}
          testID="corner-actions-close"
        >
          Cancel
        </Btn>
      </XStack>
    </SheetFrame>
  );
}
