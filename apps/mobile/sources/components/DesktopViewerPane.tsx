import * as React from 'react';
import { PanResponder } from 'react-native';
import { YStack } from 'tamagui';
import { useDesktopLayout } from '@/buzz/desktop-layout-state';
import { desktopDocumentPaneWidth, loadDesktopViewerWidth, saveDesktopViewerWidth } from '@/buzz/desktop-workbench-state';

/** One left-edge divider for artifact viewers in chats and other desktop routes. */
export function DesktopViewerPane({ children, initialShare = 0.48 }: {
  children: React.ReactNode;
  initialShare?: number;
}) {
  const { availableWidth } = useDesktopLayout();
  const [rowWidth, setRowWidth] = React.useState<number | null>(null);
  const [requestedWidth, setRequestedWidth] = React.useState<number | undefined>();
  const dragged = React.useRef(false);
  React.useEffect(() => {
    let active = true;
    void loadDesktopViewerWidth().then(width => {
      if (active && !dragged.current) setRequestedWidth(width);
    });
    return () => { active = false; };
  }, []);
  const measuredWidth = availableWidth || rowWidth || Number.POSITIVE_INFINITY;
  const width = desktopDocumentPaneWidth(measuredWidth,
    requestedWidth ?? (Number.isFinite(measuredWidth) ? measuredWidth * initialShare : undefined));
  const latest = React.useRef({ width, measuredWidth });
  latest.current = { width, measuredWidth };
  const [hovered, setHovered] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const dragStart = React.useRef(width);
  const resizePan = React.useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 2,
    onPanResponderGrant: () => {
      dragged.current = true;
      setDragging(true);
      dragStart.current = latest.current.width;
    },
    onPanResponderMove: (_, gesture) => {
      setRequestedWidth(desktopDocumentPaneWidth(latest.current.measuredWidth, dragStart.current - gesture.dx));
    },
    onPanResponderRelease: (_, gesture) => {
      setDragging(false);
      const next = desktopDocumentPaneWidth(latest.current.measuredWidth, dragStart.current - gesture.dx);
      setRequestedWidth(next);
      void saveDesktopViewerWidth(next);
    },
    onPanResponderTerminate: () => {
      setDragging(false);
    },
  }), []);
  const active = hovered || dragging;
  return <YStack width={width} height="100%" flexShrink={0} position="relative"
    backgroundColor="canvas" borderLeftWidth={1} borderLeftColor="stroke"
    onLayout={event => {
      const { x, width: laidOutWidth } = event.nativeEvent.layout;
      setRowWidth(Math.round(x + laidOutWidth));
    }} testID="desktop-inspector">
    <YStack {...(resizePan.panHandlers as object)} accessibilityLabel="Resize work pane"
      position="absolute" left={-3} top={0} bottom={0} width={7} cursor="col-resize"
      backgroundColor="transparent" alignItems="center" zIndex={4}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      testID="desktop-inspector-resizer">
      <YStack width={active ? 2 : 0} height="100%"
        backgroundColor={active ? 'strongStroke' : 'transparent'}
        pointerEvents="none" testID="desktop-inspector-resizer-rule" />
    </YStack>
    {children}
  </YStack>;
}
