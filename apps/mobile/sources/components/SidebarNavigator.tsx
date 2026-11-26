import { subscribeDesktopArtifact, type DesktopArtifactSelection } from '@/buzz/desktop-artifact-pane';
import { DesktopArtifactPane } from '@/components/buzz/DesktopArtifactPane';
import { DESKTOP_WORK_PANE_THRESHOLD } from '@/buzz/desktop-workbench-state';
import { setDesktopPaneOpen, useDesktopLayout, setDesktopAvailableWidth } from '@/buzz/desktop-layout-state';
import * as React from 'react';
import { useIsDesktop, useIsTablet, useHeaderHeight } from '@/utils/responsive';
import { SidebarView } from './SidebarView';
import { DesktopViewerPane } from './DesktopViewerPane';
import { useWindowDimensions, Platform, PanResponder } from 'react-native';
import { XStack, YStack, useTheme } from 'tamagui';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Slot, usePathname, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { Filled, Glyph } from '@/ui/grammar';
import { PaneResizer } from '@/ui/grammar-root';
import { isTauri } from '@/utils/isTauri';
import { isMacTauri, MAC_TAURI_TITLEBAR_HEIGHT } from '@/utils/macTitlebar';
import {
  canRouteForward,
  canUseRouteBack,
  getNavigatorCanGoBack,
} from '@/navigation/browserNavigation';
import { useBrowserNavigationStore } from '@/navigation/browserNavigationStore';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { monolithSession } from '@/auth/monolith-session';
import { subscribeClientReset } from '@/sync/client-reset';
import {
  showsDesktopSessionChrome,
  type DesktopSessionState,
  usesPersistentDesktopFrame,
} from './desktop-shell-policy';
import { isDesktopPlatform } from '@/utils/platform';
import {
  clampDesktopPaneWidth,
  DESKTOP_NAV_DEFAULT_WIDTH,
  DESKTOP_NAV_MIN_WIDTH,
  DESKTOP_TRANSCRIPT_MIN_WIDTH,
  loadDesktopPaneWidth,
  saveDesktopPaneWidth,
} from '@/buzz/desktop-workbench-state';

const SETUP_SURFACES = ['/beeline/community', '/beeline/create-workspace'];

export const SidebarNavigator = React.memo(function SidebarNavigator() {
  const isTablet = useIsTablet();
  // Resizing a web window must preserve the active route and its draft.
  return isTablet || Platform.OS === 'web' ? <DesktopSidebarNavigator /> : <Slot />;
});

const DesktopSidebarNavigator = React.memo(() => {
  const isTablet = useIsTablet();
  const isDesktop = useIsDesktop();
  const inDesktopShell = isTauri();
  const macTauri = isMacTauri();
  const desktopPlatform = isDesktopPlatform();
  const pathname = usePathname();
  const zenMode = useLocalSetting('zenMode');
  const [desktopSession, setDesktopSession] = React.useState<DesktopSessionState>(
    inDesktopShell ? 'checking' : 'signed-in',
  );
  // Web follows the live window: only `isTablet` (width ≥ 768) opens the
  // two-pane frame. `desktopPlatform` is true for every browser, so OR-ing it
  // here painted the desktop shell at phone width. Native Tauri follows the
  // same width class so its compact Room deck has the whole window.
  const isDesktopLayout = usesPersistentDesktopFrame(inDesktopShell, isTablet);
  // Choosing, creating or joining a Workspace is a focused setup step, like
  // onboarding: no Room sidebar (a person there may have no Workspace yet).
  const isAppSurface =
    (pathname === '/' || pathname.startsWith('/beeline/')) &&
    !pathname.includes('/onboarding') &&
    !SETUP_SURFACES.includes(pathname);
  const showSessionChrome =
    isAppSurface && showsDesktopSessionChrome(inDesktopShell, isTablet, desktopSession);
  const desktopLayout = useDesktopLayout();
  const [document, setDocument] = React.useState<DesktopArtifactSelection | null>(null);
  React.useEffect(() => {
    return subscribeDesktopArtifact((selection) => {
      if (!desktopPlatform || !isDesktopLayout || pathname.startsWith('/beeline/chat/') || desktopLayout.availableWidth < DESKTOP_WORK_PANE_THRESHOLD) return false;
      setDocument(selection);
      return true;
    });
  }, [desktopPlatform, isDesktopLayout, pathname, desktopLayout.availableWidth]);
  React.useEffect(() => {
    if (!document) return;
    setDesktopPaneOpen(true);
    return () => setDesktopPaneOpen(false);
  }, [document]);
  React.useEffect(() => setDocument(null), [pathname]);
  const showSidebar = showSessionChrome && !zenMode && desktopLayout.showRoomList;
  const { width: windowWidth } = useWindowDimensions();

  React.useEffect(() => {
    if (!inDesktopShell) return;
    let cancelled = false;
    const refresh = () => {
      void Promise.all([monolithSession.identityId(), loadBuzzIdentity()])
        .then(([identityId, legacyIdentity]) => {
          if (!cancelled)
            setDesktopSession(identityId || legacyIdentity ? 'signed-in' : 'signed-out');
        })
        .catch(() => {
          if (!cancelled) setDesktopSession('signed-out');
        });
    };
    refresh();
    const unsubscribe = subscribeClientReset(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [inDesktopShell, pathname]);

  const [storedDrawerWidth, setStoredDrawerWidth] = React.useState(DESKTOP_NAV_DEFAULT_WIDTH);
  const dragStartWidth = React.useRef(storedDrawerWidth);
  React.useEffect(() => {
    if (!desktopPlatform) return;
    void loadDesktopPaneWidth('navigation').then(setStoredDrawerWidth);
  }, [desktopPlatform]);
  // Reserve room for the content pane, but only when the window is wide enough
  // that doing so still leaves the nav pane at least its own minimum width.
  // Otherwise `Math.min` against a ceiling below that minimum always loses to
  // clampDesktopPaneWidth's floor, pinning the rendered width to the floor no
  // matter what the user drags to — the resize handle stops moving anything.
  const maxWidthForContent = windowWidth - DESKTOP_TRANSCRIPT_MIN_WIDTH;
  const fullDrawerWidth = isDesktopLayout
    ? clampDesktopPaneWidth(
        'navigation',
        maxWidthForContent > DESKTOP_NAV_MIN_WIDTH
          ? Math.min(storedDrawerWidth, maxWidthForContent)
          : storedDrawerWidth,
      )
    : DESKTOP_NAV_DEFAULT_WIDTH;
  const drawerWidth = showSessionChrome && !zenMode ? (showSidebar ? fullDrawerWidth : 0) : 0;
  React.useEffect(() => {
    setDesktopAvailableWidth(windowWidth - drawerWidth);
  }, [windowWidth, drawerWidth]);
  // fullDrawerWidth changes on every move (it derives from storedDrawerWidth,
  // which onPanResponderMove updates), so it can't be a dependency here: on
  // web, rebuilding the PanResponder mid-gesture makes react-native-web
  // re-register the node's responder config, which resets the gesture's
  // touch-move accounting and breaks cumulative `dx` tracking. Read the
  // latest width through a ref instead, so the responder instance — and the
  // gesture it's tracking — stays stable for the whole drag.
  const fullDrawerWidthRef = React.useRef(fullDrawerWidth);
  fullDrawerWidthRef.current = fullDrawerWidth;
  const resizePan = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => desktopPlatform && showSidebar,
        onMoveShouldSetPanResponder: (_, gesture) => desktopPlatform && Math.abs(gesture.dx) > 2,
        onPanResponderGrant: () => {
          dragStartWidth.current = fullDrawerWidthRef.current;
        },
        onPanResponderMove: (_, gesture) =>
          setStoredDrawerWidth(
            clampDesktopPaneWidth('navigation', dragStartWidth.current + gesture.dx),
          ),
        onPanResponderRelease: (_, gesture) => {
          const width = clampDesktopPaneWidth('navigation', dragStartWidth.current + gesture.dx);
          setStoredDrawerWidth(width);
          void saveDesktopPaneWidth('navigation', width);
        },
      }),
    [desktopPlatform, showSidebar],
  );

  return (
    <YStack flex={1}>
      {/* On macOS Tauri desktop, a shared top strip clears traffic lights across both panes
          so the sidebar and active content header sit on one baseline. Compact windows keep
          PersistentHeader for Zen/Back/Forward controls. */}
      {showSessionChrome && !isDesktop && <PersistentHeader />}
      {showSessionChrome && isDesktop && macTauri && (
        <XStack
          height={MAC_TAURI_TITLEBAR_HEIGHT}
          backgroundColor="raised"
          borderBottomWidth={1}
          borderColor="stroke"
          alignItems="center"
          data-tauri-drag-region="true"
          testID="mac-tauri-titlebar"
        >
          <YStack width={92} />
        </XStack>
      )}
      <YStack flex={1} minHeight={0} position="relative">
        <XStack flex={1} minHeight={0} alignItems="stretch">
          {showSessionChrome && (
            <YStack width={drawerWidth} overflow="hidden" backgroundColor="canvas">
              <SidebarView />
            </YStack>
          )}
          <YStack flex={1} minWidth={0}>
            <Slot />
          </YStack>
          {document && desktopLayout.availableWidth >= DESKTOP_WORK_PANE_THRESHOLD && (
            <DesktopViewerPane initialShare={0.55}>
              <DesktopArtifactPane {...document} onClose={() => setDocument(null)} />
            </DesktopViewerPane>
          )}
        </XStack>
        {desktopPlatform && showSidebar && (
          <PaneResizer
            {...resizePan.panHandlers}
            accessibilityLabel="Resize navigation pane"
            edge={drawerWidth}
            zIndex={1200}
            testID="desktop-navigation-resizer"
          />
        )}
      </YStack>
    </YStack>
  );
});

// Header block that stays in the same position whether zen mode is on or off
const PersistentHeader = React.memo(() => {
  const theme = useTheme();
  const safeArea = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const router = useRouter();
  const [zenMode, setZenMode] = useLocalSettingMutable('zenMode');
  const inTauri = isTauri();
  const isDesktop = useIsDesktop();
  const isMacTauri = inTauri && typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

  const routeHistory = useBrowserNavigationStore((s) => s.routeHistory);
  const canGoForward = useBrowserNavigationStore((s) =>
    s.routeHistory ? canRouteForward(s.routeHistory) : false,
  );
  const canGoBack = routeHistory
    ? canUseRouteBack(routeHistory, getNavigatorCanGoBack(router))
    : false;

  const handleZenToggle = React.useCallback(() => {
    setZenMode(!zenMode);
  }, [zenMode, setZenMode]);

  const handleBack = React.useCallback(() => {
    const nav = useBrowserNavigationStore.getState();
    if (!nav.routeHistory || !canUseRouteBack(nav.routeHistory, getNavigatorCanGoBack(router)))
      return;
    nav.markRouteBack();
    router.back();
  }, [router]);

  const handleForward = React.useCallback(() => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const nav = useBrowserNavigationStore.getState();
      if (!nav.routeHistory || !canRouteForward(nav.routeHistory)) return;
      nav.markRouteForward();
      window.history.forward();
    }
  }, []);

  return (
    // The safe-area band above stays clear; the macOS traffic lights take the
    // leading inset, which stays part of the drag region.
    <XStack
      position="absolute"
      top={safeArea.top}
      left={0}
      right={0}
      height={headerHeight}
      paddingRight="4"
      alignItems="center"
      zIndex={1100}
      pointerEvents="box-none"
      data-tauri-drag-region={inTauri ? 'true' : undefined}
    >
      <YStack width={isMacTauri ? 92 : 16} />
      {/* Zen / Back / Forward buttons */}
      {!isDesktop && (
        <XStack
          alignItems="center"
          gap="1"
          pointerEvents="auto"
          data-tauri-drag-region={inTauri ? 'false' : undefined}
        >
          <YStack
            onPress={handleZenToggle}
            hitSlop={10}
            width={28}
            height={28}
            alignItems="center"
            justifyContent="center"
            accessibilityRole="button"
            accessibilityLabel={"Zen mode"}
          >
            <YStack width={18} height={18}>
              <Filled
                view={Image}
                source={require('@/assets/images/zen-icon.png')}
                contentFit="contain"
                tintColor={zenMode ? theme.needsYou?.val : theme.ink?.val}
              />
            </YStack>
          </YStack>
          <YStack
            tabIndex={canGoBack ? 0 : -1}
            onPress={canGoBack ? handleBack : undefined}
            hitSlop={10}
            width={28}
            height={28}
            alignItems="center"
            justifyContent="center"
            opacity={canGoBack ? 1 : 0.3}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canGoBack }}
          >
            <Glyph icon={ChevronLeft} size={20} color="ink" />
          </YStack>
          {Platform.OS === 'web' && (
            <YStack
              tabIndex={canGoForward ? 0 : -1}
              onPress={canGoForward ? handleForward : undefined}
              hitSlop={10}
              width={28}
              height={28}
              alignItems="center"
              justifyContent="center"
              opacity={canGoForward ? 1 : 0.3}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canGoForward }}
            >
              <Glyph icon={ChevronRight} size={20} color="ink" />
            </YStack>
          )}
        </XStack>
      )}
    </XStack>
  );
});
