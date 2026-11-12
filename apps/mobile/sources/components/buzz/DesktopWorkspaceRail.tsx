import * as React from 'react';
import { Platform } from 'react-native';
import { YStack } from 'tamagui';
import { Plus } from 'lucide-react-native';
import {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { WORKSPACE_RAIL_TILE, workspacePictureSeat } from '@/buzz/workspace-tile';
import { DesktopWorkspacePortal } from '@/components/buzz/DesktopWorkspacePortal';
import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
} from '@/buzz/host-scheduler';
import { Glyph, Motion, ScrimButton, T } from '@/ui/grammar';

const RAIL_WIDTH = 76;

/**
 * The reference Workspace tile, and the picture seated in its bezel like a
 * picture in a frame rather than clipped against it (`buzz/workspace-tile`).
 * The mobile drawer (`CommunityRail`) wears this same tile.
 */
const TILE = WORKSPACE_RAIL_TILE;
const TILE_SIZE = TILE.size;
const TILE_SEAT = workspacePictureSeat(TILE);

export type DesktopWorkspaceRailItem = {
  readonly id: string;
  readonly name: string;
  readonly avatar?: string;
  readonly roomCount: number;
  readonly needsAttention: boolean;
};

type DesktopWorkspaceRailProps = {
  readonly open: boolean;
  readonly workspaces: readonly DesktopWorkspaceRailItem[];
  readonly activeWorkspaceId: string | null;
  readonly onClose: () => void;
  readonly onSelect: (workspaceId: string) => void;
  readonly onAdd: () => void;
  /** The account hub. The rail's scrim covers the pane that also names it. */
  readonly onOpenAccount: () => void;
  readonly viewerPubkey?: string;
  readonly viewerName?: string;
  readonly viewerAvatarUrl?: string;
  readonly viewerFace?: string;
};

export function DesktopWorkspaceRail({
  open,
  workspaces,
  activeWorkspaceId,
  onClose,
  onSelect,
  onAdd,
  onOpenAccount,
  viewerPubkey,
  viewerName,
  viewerAvatarUrl,
  viewerFace,
}: DesktopWorkspaceRailProps) {
  const reducedMotion = useReducedMotion();
  const railX = useSharedValue(reducedMotion ? 0 : -RAIL_WIDTH);
  const tileRefs = React.useRef<Array<any>>([]);
  const [hoveredWorkspaceId, setHoveredWorkspaceId] = React.useState<string | null>(null);
  const [focusedWorkspaceId, setFocusedWorkspaceId] = React.useState<string | null>(null);
  const [addFocused, setAddFocused] = React.useState(false);
  const [accountFocused, setAccountFocused] = React.useState(false);
  const [accountHovered, setAccountHovered] = React.useState(false);
  const activeIndex = Math.max(
    0,
    workspaces.findIndex((workspace) => workspace.id === activeWorkspaceId),
  );
  const focusedIndexRef = React.useRef(activeIndex);

  React.useEffect(() => {
    if (!open) return;
    focusedIndexRef.current = activeIndex;
    railX.value = reducedMotion ? 0 : -RAIL_WIDTH;
    railX.value = withTiming(0, {
      duration: reducedMotion ? 0 : 180,
      easing: Easing.bezier(0.22, 1, 0.36, 1),
      reduceMotion: ReduceMotion.System,
    });
    const frame = scheduleAnimationFrame(() => tileRefs.current[activeIndex]?.focus?.());
    return () => {
      if (frame !== false) cancelScheduledAnimationFrame(frame);
    };
  }, [activeIndex, open, railX, reducedMotion]);

  React.useEffect(() => {
    if (!open || Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'Enter') {
        if (focusedIndexRef.current === workspaces.length) {
          event.preventDefault();
          onAdd();
          return;
        }
        if (focusedIndexRef.current === workspaces.length + 1) {
          event.preventDefault();
          onOpenAccount();
          return;
        }
        const workspace = workspaces[focusedIndexRef.current];
        if (!workspace) return;
        event.preventDefault();
        if (workspace.id === activeWorkspaceId) onClose();
        else onSelect(workspace.id);
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const startIndex = focusedIndexRef.current;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      // Workspaces, then the add tile, then the account hub.
      const itemCount = workspaces.length + 2;
      const nextIndex = (startIndex + delta + itemCount) % itemCount;
      focusedIndexRef.current = nextIndex;
      tileRefs.current[nextIndex]?.focus?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeWorkspaceId,
    activeIndex,
    onAdd,
    onClose,
    onOpenAccount,
    onSelect,
    open,
    workspaces,
  ]);

  const animatedRailStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: railX.value }],
  }));

  if (!open) return null;

  return (
    <DesktopWorkspacePortal>
      <YStack
        accessibilityLabel="Workspace switcher"
        accessibilityViewIsModal
        position={'fixed' as any}
        top={0}
        right={0}
        bottom={0}
        left={0}
        zIndex={2000}
        testID="desktop-workspace-rail-overlay"
      >
        <ScrimButton
          label="Close Workspace switcher"
          onPress={onClose}
          testID="desktop-workspace-rail-scrim"
        />
        <YStack
          accessibilityLabel="Workspaces"
          accessibilityRole="menu"
          position="absolute"
          top={0}
          bottom={0}
          left={0}
          width={RAIL_WIDTH}
          overflow="visible"
          testID="desktop-workspace-rail"
        >
          <Motion fill motion={animatedRailStyle}>
            <YStack
              flex={1}
              overflow="visible"
              alignItems="center"
              backgroundColor="raised"
              borderRightWidth={1}
              borderRightColor="strongStroke"
            >
              <YStack paddingTop="4" alignItems="center" gap="2" overflow="visible">
                {workspaces.map((workspace, index) => {
                  const current = workspace.id === activeWorkspaceId;
                  const labelled = (hoveredWorkspaceId ?? focusedWorkspaceId) === workspace.id;
                  const roomLabel = `${workspace.roomCount} chats`;
                  const pillHeight = current ? 36 : 10;
                  return (
                    <YStack
                      key={workspace.id}
                      position="relative"
                      width={TILE_SIZE}
                      height={TILE_SIZE}
                      overflow="visible"
                    >
                      {(current || workspace.needsAttention) && (
                        <YStack
                          position="absolute"
                          left={-14}
                          top={(TILE_SIZE - pillHeight) / 2}
                          width={4}
                          height={pillHeight}
                          borderTopRightRadius="sm"
                          borderBottomRightRadius="sm"
                          backgroundColor="needsYou"
                          testID={
                            current
                              ? `desktop-workspace-current-${workspace.id}`
                              : `desktop-workspace-needs-you-${workspace.id}`
                          }
                        />
                      )}
                      <YStack
                        accessibilityLabel={`${workspace.name}, ${roomLabel}${
                          current ? ', you are here' : workspace.needsAttention ? ', needs you' : ''
                        }`}
                        accessibilityRole="menuitem"
                        accessibilityState={{ selected: current }}
                        tabIndex={0}
                        onBlur={() => {
                          setFocusedWorkspaceId(null);
                        }}
                        onFocus={() => {
                          focusedIndexRef.current = index;
                          setFocusedWorkspaceId(workspace.id);
                        }}
                        onMouseEnter={() => setHoveredWorkspaceId(workspace.id)}
                        onMouseLeave={() => setHoveredWorkspaceId(null)}
                        onPress={() => (current ? onClose() : onSelect(workspace.id))}
                        ref={(node: any) => {
                          tileRefs.current[index] = node;
                        }}
                        width={TILE_SIZE}
                        height={TILE_SIZE}
                        minWidth={44}
                        minHeight={44}
                        alignItems="center"
                        justifyContent="center"
                        borderRadius="lg"
                        backgroundColor="highlight"
                        borderWidth={current || focusedWorkspaceId === workspace.id ? 2 : 0}
                        borderColor="needsYou"
                        outlineStyle="none"
                        cursor="pointer"
                        testID={`desktop-workspace-tile-${workspace.id}`}
                      >
                        {/* The picture's seat: square, centred, and rounded
                            parallel to the bezel, so it does not move when a
                            Workspace becomes current and the tile puts its
                            bezel on. */}
                        <YStack
                          width={TILE_SEAT.pictureSize}
                          height={TILE_SEAT.pictureSize}
                          alignItems="center"
                          justifyContent="center"
                          borderRadius="md"
                          overflow="hidden"
                        >
                          <IdentityMark
                            avatarUrl={workspace.avatar}
                            kind="workspace"
                            name={workspace.name}
                            seed={workspace.id}
                            size={TILE_SEAT.pictureSize}
                            testID={`desktop-workspace-mark-${workspace.id}`}
                          />
                        </YStack>
                      </YStack>
                      {labelled && (
                        <TileLabel testID="desktop-workspace-label" name={workspace.name}>
                          {roomLabel}
                          {current ? ' · you are here' : ''}
                        </TileLabel>
                      )}
                    </YStack>
                  );
                })}
                <YStack width={32} height={1} marginVertical="1" backgroundColor="strongStroke" />
                <YStack
                  accessibilityLabel="Create or join a Workspace"
                  accessibilityRole="menuitem"
                  tabIndex={0}
                  onBlur={() => setAddFocused(false)}
                  onFocus={() => {
                    focusedIndexRef.current = workspaces.length;
                    setAddFocused(true);
                  }}
                  onPress={onAdd}
                  ref={(node: any) => {
                    tileRefs.current[workspaces.length] = node;
                  }}
                  width={TILE_SIZE}
                  height={TILE_SIZE}
                  minWidth={44}
                  minHeight={44}
                  alignItems="center"
                  justifyContent="center"
                  borderRadius="lg"
                  backgroundColor="transparent"
                  borderWidth={addFocused ? 2 : 1}
                  borderStyle="dashed"
                  borderColor={addFocused ? 'needsYou' : 'strongStroke'}
                  outlineStyle="none"
                  cursor="pointer"
                  testID="desktop-workspace-add"
                >
                  <Glyph icon={Plus} accent />
                </YStack>
                <YStack width={32} height={1} marginVertical="1" backgroundColor="strongStroke" />
                {/* The account hub. The rail's scrim covers the navigation pane
                    that also names it, so without this the rail is a dead end for
                    everything that is not a Workspace. */}
                <YStack position="relative" width={TILE_SIZE} height={TILE_SIZE} overflow="visible">
                  <YStack
                    accessibilityLabel={viewerName ? `${viewerName} — Settings` : 'Settings'}
                    accessibilityRole="menuitem"
                    tabIndex={0}
                    onBlur={() => setAccountFocused(false)}
                    onFocus={() => {
                      focusedIndexRef.current = workspaces.length + 1;
                      setAccountFocused(true);
                    }}
                    onMouseEnter={() => setAccountHovered(true)}
                    onMouseLeave={() => setAccountHovered(false)}
                    onPress={onOpenAccount}
                    ref={(node: any) => {
                      tileRefs.current[workspaces.length + 1] = node;
                    }}
                    width={TILE_SIZE}
                    height={TILE_SIZE}
                    minWidth={44}
                    minHeight={44}
                    alignItems="center"
                    justifyContent="center"
                    borderRadius="lg"
                    backgroundColor="highlight"
                    borderWidth={accountFocused ? 2 : 0}
                    borderColor="needsYou"
                    outlineStyle="none"
                    cursor="pointer"
                    testID="desktop-workspace-account"
                  >
                    {viewerPubkey ? (
                      <IdentityMark
                        avatarUrl={viewerAvatarUrl}
                        face={viewerFace}
                        kind="human"
                        name={viewerName ?? 'You'}
                        seed={viewerPubkey}
                        size={32}
                        testID="desktop-workspace-account-mark"
                      />
                    ) : (
                      // The identity has not loaded yet. Hold the mark's box open
                      // rather than drawing a stand-in, exactly as the navigation
                      // pane's own account row does.
                      <YStack width={32} height={32} />
                    )}
                  </YStack>
                  {(accountHovered || accountFocused) && (
                    <TileLabel testID="desktop-workspace-account-label" name="Settings">
                      {viewerName}
                    </TileLabel>
                  )}
                </YStack>
              </YStack>
            </YStack>
          </Motion>
        </YStack>
      </YStack>
    </DesktopWorkspacePortal>
  );
}

/**
 * A tile's name card, hung off the rail's right edge and centred on the tile.
 * The rail centres each `TILE_SIZE` tile in `RAIL_WIDTH`, so the rail's right
 * edge sits `RAIL_WIDTH / 2 + TILE_SIZE / 2` from the slot's origin; one
 * spacing step past it is the deliberate breathing room.
 */
function TileLabel({ name, children, testID }: { name: string; children?: React.ReactNode; testID: string }) {
  return (
    <YStack
      pointerEvents="none"
      position="absolute"
      left={RAIL_WIDTH / 2 + TILE_SIZE / 2 + 8}
      top={0}
      bottom={0}
      justifyContent="center"
      zIndex={2}
    >
      <YStack
        minWidth={120}
        maxWidth={260}
        padding="2"
        borderWidth={1}
        borderColor="strongStroke"
        borderRadius="md"
        backgroundColor="highlight"
        testID={testID}
      >
        <T v="meta" numberOfLines={1}>
          {name}
        </T>
        {children ? (
          <T v="meta" color="secondary" numberOfLines={1}>
            {children}
          </T>
        ) : null}
      </YStack>
    </YStack>
  );
}
