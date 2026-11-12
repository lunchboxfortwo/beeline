import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { HullDialogInput } from '@/components/buzz/HullDialog';
import { useTextDraft } from '@/buzz/use-text-draft';
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, YStack } from 'tamagui';
import { T } from '@/ui/grammar';
import type { ForwardTarget, ForwardTargetGroup } from '@/buzz/message-forward';
import {
  HullActionSheetCancel,
  HullActionSheetModal,
  HullActionSheetRow,
} from './HullActionSheet';
import { SurfaceGlyphLoader } from './SurfaceGlyphLoader';

type ForwardMessagePickerSheetProps = {
  busyRoomId: string | null;
  error: string | null;
  onClose: () => void;
  onDismiss?: () => void;
  onForward: (target: ForwardTarget) => Promise<boolean>;
  targets: readonly ForwardTarget[] | null;
  visible: boolean;
  draftContext?: string;
};

const SECTIONS: readonly { group: ForwardTargetGroup; label: string }[] = [
  { group: 'people', label: 'PEOPLE' },
  { group: 'agents', label: 'AGENTS' },
  { group: 'rooms', label: 'CHATS' },
];

export function ForwardMessagePickerSheet({
  busyRoomId,
  error,
  onClose,
  onDismiss,
  onForward,
  targets,
  visible,
  draftContext = 'global',
}: ForwardMessagePickerSheetProps) {
  const [completedTarget, setCompletedTarget] = useState<string | null>(null);
  const [resultLaidOut, setResultLaidOut] = useState(false);
  useEffect(() => {
    if (visible) setCompletedTarget(null);
  }, [visible]);
  useEffect(() => {
    if (!completedTarget || !resultLaidOut || !visible) return;
    // Wait for the native result layout, then let it paint before dismissal.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(onClose);
    });
    return () => cancelAnimationFrame(frame);
  }, [completedTarget, resultLaidOut, visible, onClose]);
  const [query, setQuery] = useTextDraft(`forward-search:${draftContext}`, '');

  const filteredTargets = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return targets ?? [];
    return (targets ?? []).filter((target) =>
      target.label.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [query, targets]);

  return (
    <HullActionSheetModal
      accessibilityLabel="Close forward picker"
      onClose={onClose}
      onDismiss={onDismiss}
      subtitle="Choose a chat or member in this Workspace"
      testID="forward-room-picker"
      title="Forward message"
      visible={visible}
    >
      <HullDialogInput
        accessibilityLabel="Search forward destinations"
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setQuery}
        placeholder="Search destinations"
        returnKeyType="search"
        variant="sheetSearch"
        testID="forward-room-search"
        value={query}
      />
      <ScrollView
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        maxHeight={360}
        flexGrow={0}
        testID="forward-room-list"
      >
        <YStack paddingBottom="1">
        {targets === null ? (
          <YStack
            accessibilityLiveRegion="polite"
            alignItems="center"
            paddingHorizontal="6"
            paddingVertical="4"
            gap="2"
            testID="forward-destinations-loader"
          >
            <SurfaceGlyphLoader compact />
            <T v="metaStrong" color="secondary" textAlign="center">LOADING DESTINATIONS…</T>
          </YStack>
        ) : filteredTargets.length ? (
          SECTIONS.map((section) => {
            const sectionTargets = filteredTargets.filter(
              (target) => target.group === section.group,
            );
            if (!sectionTargets.length) return null;
            return (
              <React.Fragment key={section.group}>
                <RoomListSectionHeader title={section.label} surface="sheet" />
                {sectionTargets.map((target) => (
                  <YStack
                    key={`${target.kind}:${target.id}:${completedTarget === target.id ? 'accepted' : 'pending'}`}
                    testID={completedTarget === target.id ? 'forward-accepted-result' : undefined}
                    onLayout={completedTarget === target.id ? () => setResultLaidOut(true) : undefined}
                  >
                    <HullActionSheetRow
                      chevron="right"
                      disabled={Boolean(busyRoomId || (completedTarget && completedTarget !== target.id))}
                      label={target.label}
                      metadata={completedTarget === target.id ? 'FORWARDED' : busyRoomId === target.id ? 'SENDING' : undefined}
                      onPress={completedTarget ? undefined : async () => {
                        setCompletedTarget(null);
                        setResultLaidOut(false);
                        if (await onForward(target)) setCompletedTarget(target.id);
                      }}
                      testID={`forward-${target.kind}-${target.id}`}
                    />
                  </YStack>
                ))}
              </React.Fragment>
            );
          })
        ) : (
          <T v="metaStrong" color="secondary" textAlign="center" accessibilityLiveRegion="polite">
            {error ??
              (query.trim()
                ? `No destinations match “${query.trim()}”.`
                : 'NO OTHER DESTINATIONS AVAILABLE')}
          </T>
        )}
        </YStack>
      </ScrollView>
      <HullActionSheetCancel onPress={onClose} testID="forward-room-cancel" />
    </HullActionSheetModal>
  );
}
