import React, { createContext, useCallback, useContext, useState } from 'react';
import * as Haptics from 'expo-haptics';
import {
  Easing,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { ScrollView, Separator, YStack } from 'tamagui';
import { Plus, X } from 'lucide-react-native';
import { WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { WORKSPACE_RAIL_TILE } from '@/buzz/workspace-tile';
import { Glyph, Motion, SafeBottom, SafeTop, T } from '@/ui/grammar';

const DRAWER_WIDTH = 72;
const DRAWER_DURATION_MS = 180;
const TILE = WORKSPACE_RAIL_TILE;

export type CommunityRailItem = {
  communityId: string;
  name: string;
  avatar?: string;
};

type CommunityRailProps = {
  communities: CommunityRailItem[];
  activeCommunityId: string | null;
  onSelect: (communityId: string | null) => void;
  onAdd: () => void;
  /** Long-press a Workspace tile to arm its exit affordance; confirm from there. */
  onLeaveWorkspace?: (communityId: string) => void;
};

/**
 * A Workspace slot: the picture in its tile, a brass bezel and an edge bar on
 * the current one. Long-press arms one exit control on the tile's corner.
 */
function RailButton({ active, label, children, onPress, onLongPress, exitArmed = false, onExitPress, testID }: {
  active: boolean; label: string; children: React.ReactNode; onPress: () => void; onLongPress?: () => void;
  exitArmed?: boolean; onExitPress?: () => void; testID?: string;
}) {
  return (
    <YStack width={DRAWER_WIDTH} height={58} alignItems="center" justifyContent="center">
      {active ? <YStack position="absolute" top={9} bottom={9} left={0} width={2} backgroundColor="needsYou" /> : null}
      <YStack
        width={TILE.size}
        height={TILE.size}
        alignItems="center"
        justifyContent="center"
        borderRadius="md"
        borderWidth={2}
        borderColor={active ? 'needsYou' : 'transparent'}
        accessibilityRole="button"
        aria-label={label}
        aria-selected={active}
        onPress={onPress}
        onLongPress={onLongPress}
        testID={testID}
      >
        {children}
      </YStack>
      {exitArmed ? (
        <YStack
          position="absolute"
          top={2}
          right={4}
          width={20}
          height={20}
          alignItems="center"
          justifyContent="center"
          borderRadius="sm"
          backgroundColor="highlight"
          accessibilityRole="button"
          aria-label={`Exit ${label}`}
          onPress={onExitPress}
          testID={`workspace-exit-${testID?.replace('community-rail-', '') ?? ''}`}
        >
          <Glyph icon={X} size={14} />
        </YStack>
      ) : null}
    </YStack>
  );
}

/** The phone's Workspace switcher: one tile per Workspace, then Add. Settings is its own tab. */
export function CommunityRail({ communities, activeCommunityId, onSelect, onAdd, onLeaveWorkspace }: CommunityRailProps) {
  // Long-press arms ONE tile's exit affordance; any other tap dismisses it.
  const [exitArmedId, setExitArmedId] = useState<string | null>(null);
  return (
    // No surface of its own: the rail is the canvas it slides over, held apart by one edge.
    <YStack flex={1} width={DRAWER_WIDTH} alignItems="center" backgroundColor="canvas" borderRightWidth={1} borderColor="stroke"
      aria-label={`${WORKSPACE_LABEL} switcher`}>
      <SafeTop />
      <ScrollView flex={1} width="100%" showsVerticalScrollIndicator={false}>
        <YStack paddingVertical="1" alignItems="center">
          {communities.map((community) => {
            const active = activeCommunityId === community.communityId;
            return (
              <RailButton
                key={community.communityId}
                active={active}
                label={community.name}
                onPress={() => {
                  // A tap anywhere while the exit control is showing just dismisses it.
                  if (exitArmedId) { setExitArmedId(null); return; }
                  onSelect(community.communityId);
                }}
                onLongPress={onLeaveWorkspace ? () => { void Haptics.selectionAsync(); setExitArmedId(community.communityId); } : undefined}
                exitArmed={exitArmedId === community.communityId}
                onExitPress={() => { setExitArmedId(null); onLeaveWorkspace?.(community.communityId); }}
                testID={`community-rail-${community.communityId}`}
              >
                <YStack width={TILE.pictureSize} height={TILE.pictureSize} borderRadius="sm" overflow="hidden" alignItems="center" justifyContent="center">
                  <IdentityMark
                    kind="workspace"
                    seed={community.communityId}
                    avatarUrl={community.avatar}
                    name={community.name}
                    size={TILE.pictureSize}
                    selected={active}
                    testID={`workspace-avatar-${community.communityId}`}
                  />
                </YStack>
              </RailButton>
            );
          })}
          <Separator borderColor="stroke" width={40} marginVertical="2" />
          <YStack width={DRAWER_WIDTH} minHeight={48} paddingVertical="1" alignItems="center" justifyContent="center" gap="1"
            accessibilityRole="button" aria-label={`Create or join a ${WORKSPACE_LABEL}`} onPress={onAdd} testID="community-rail-add">
            <Glyph icon={Plus} />
            <T v="meta" color="secondary">Add</T>
          </YStack>
        </YStack>
      </ScrollView>
      <SafeBottom />
    </YStack>
  );
}

type CommunityDrawerContextValue = {
  drawerOpen: boolean;
  openDrawer: () => void;
};

const CommunityDrawerContext = createContext<CommunityDrawerContextValue | null>(null);

/** Today's Workspace switcher, opened from the list header inside the shell. */
export function useCommunityDrawer(): CommunityDrawerContextValue | null {
  return useContext(CommunityDrawerContext);
}

type BuzzCommunityShellProps = CommunityRailProps & {
  children: React.ReactNode;
};

export function BuzzCommunityShell({ children, communities, activeCommunityId, onSelect, onAdd, onLeaveWorkspace }: BuzzCommunityShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerX = useSharedValue(-DRAWER_WIDTH);
  const scrimOpacity = useSharedValue(0);
  const reducedMotion = useReducedMotion();

  const openDrawer = useCallback(() => {
    drawerX.value = -DRAWER_WIDTH;
    scrimOpacity.value = 0;
    setDrawerOpen(true);
    drawerX.value = withTiming(0, { duration: DRAWER_DURATION_MS, easing: Easing.bezier(0.22, 1, 0.36, 1), reduceMotion: ReduceMotion.System });
    scrimOpacity.value = withTiming(0.78, { duration: 120, reduceMotion: ReduceMotion.System });
  }, [drawerX, scrimOpacity]);

  const closeDrawer = useCallback(() => {
    scrimOpacity.value = withTiming(0, { duration: 90, reduceMotion: ReduceMotion.System });
    drawerX.value = withTiming(
      -DRAWER_WIDTH,
      { duration: reducedMotion ? 0 : 135, easing: Easing.out(Easing.poly(5)), reduceMotion: ReduceMotion.System },
      (finished) => { if (finished) runOnJS(setDrawerOpen)(false); },
    );
  }, [drawerX, reducedMotion, scrimOpacity]);

  const selectAndClose = useCallback((communityId: string | null) => {
    closeDrawer();
    void Haptics.selectionAsync();
    onSelect(communityId);
  }, [closeDrawer, onSelect]);

  const addAndClose = useCallback(() => {
    closeDrawer();
    onAdd();
  }, [closeDrawer, onAdd]);

  const drawerStyle = useAnimatedStyle(() => ({ transform: [{ translateX: drawerX.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrimOpacity.value }));

  return (
    <CommunityDrawerContext.Provider value={{ drawerOpen, openDrawer }}>
      <YStack flex={1} backgroundColor="canvas">
        <YStack flex={1} minWidth={0} backgroundColor="canvas">{children}</YStack>
        {drawerOpen ? (
          <YStack position="absolute" top={0} right={0} bottom={0} left={0} zIndex={20} testID="community-drawer-overlay">
            <Motion overlay motion={scrimStyle}>
              <YStack position="absolute" top={0} right={0} bottom={0} left={DRAWER_WIDTH} backgroundColor="canvas" accessibilityRole="button"
                aria-label={`Close ${WORKSPACE_LABEL} switcher`} onPress={closeDrawer} testID="community-drawer-scrim" />
            </Motion>
            <YStack position="absolute" top={0} bottom={0} left={0} width={DRAWER_WIDTH}>
              <Motion fill motion={drawerStyle} testID="community-drawer">
                <CommunityRail
                  communities={communities}
                  activeCommunityId={activeCommunityId}
                  onSelect={selectAndClose}
                  onAdd={addAndClose}
                  onLeaveWorkspace={onLeaveWorkspace}
                />
              </Motion>
            </YStack>
          </YStack>
        ) : null}
      </YStack>
    </CommunityDrawerContext.Provider>
  );
}
