import React, { useEffect, useRef, useState } from 'react';
import { PanResponder, Platform } from 'react-native';
import { YStack } from 'tamagui';
import type { AttachmentReference } from '@beeline/buzz-client';

import { ArtifactImage } from '@/components/buzz/ArtifactMedia';
import { showPictureActions } from '@/buzz/picture-actions';
import { ZoomBar } from '@/ui/screens/viewers/ViewerChrome';
import {
  MAX_IMAGE_ZOOM,
  clampImageZoom,
  zoomImageAt,
  type ImageFrame,
  type ImageZoom,
} from '@/buzz/image-zoom';

const PHOTO_SWIPE_SLOP = 10;
const PHOTO_SWIPE_DISTANCE = 48;

export function ZoomableArtifactImage({
  attachment,
  title,
  onSwipePhoto,
  testIDPrefix = 'artifact-viewer',
}: {
  attachment: AttachmentReference;
  title: string;
  onSwipePhoto?: (direction: -1 | 1) => void;
  testIDPrefix?: string;
}) {
  const [zoom, setZoom] = useState<ImageZoom>({ scale: 1, x: 0, y: 0 });
  const zoomRef = useRef(zoom);
  const frameRef = useRef<ImageFrame>({ width: 0, height: 0 });
  const gestureRef = useRef({ distance: 0, x: 0, y: 0, start: zoom });
  // Only a gesture that began with one finger at fitted size may page.
  const swipeRef = useRef(false);
  const swipeMotionRef = useRef({ x: 0, y: 0, dx: 0, dy: 0 });
  const swipePhotoRef = useRef(onSwipePhoto);
  swipePhotoRef.current = onSwipePhoto;
  const attachmentRef = useRef(attachment);
  attachmentRef.current = attachment;
  const liveRef = useRef(true);
  const setImageZoom = (next: ImageZoom) => {
    zoomRef.current = next;
    setZoom(next);
  };
  useEffect(() => {
    liveRef.current = true;
    frameRef.current = { width: frameRef.current.width, height: frameRef.current.height };
    swipeRef.current = false;
    setImageZoom({ scale: 1, x: 0, y: 0 });
    return () => { liveRef.current = false; };
  }, [attachment]);

  const center = () => ({ x: 0, y: 0 });
  const step = (factor: number) => {
    setImageZoom(
      zoomImageAt(zoomRef.current, zoomRef.current.scale * factor, center(), frameRef.current),
    );
  };
  const touches = (event: {
    nativeEvent: {
      touches?: readonly { pageX: number; pageY: number }[];
      pageX?: number;
      pageY?: number;
    };
  }) => {
    const native = event.nativeEvent;
    if (native.touches?.length) return native.touches;
    return native.pageX !== undefined && native.pageY !== undefined
      ? [{ pageX: native.pageX, pageY: native.pageY }]
      : [];
  };
  const gesture = useRef(
    PanResponder.create({
      onStartShouldSetPanResponderCapture: (event) => {
        const points = touches(event);
        swipeMotionRef.current = { x: points[0]?.pageX ?? 0, y: points[0]?.pageY ?? 0, dx: 0, dy: 0 };
        swipeRef.current = Boolean(
          swipePhotoRef.current && points.length === 1 && zoomRef.current.scale === 1,
        );
        return false;
      },
      onMoveShouldSetPanResponderCapture: (event) => {
        const points = touches(event);
        if (points.length > 1) {
          swipeRef.current = false;
          return true;
        }
        if (zoomRef.current.scale > 1) return true;
        const motion = swipeMotionRef.current;
        if (points[0]) {
          motion.dx = points[0].pageX - motion.x;
          motion.dy = points[0].pageY - motion.y;
        }
        if (Math.abs(motion.dy) > PHOTO_SWIPE_SLOP && Math.abs(motion.dy) >= Math.abs(motion.dx)) {
          swipeRef.current = false;
        }
        return swipeRef.current && Math.abs(motion.dx) > PHOTO_SWIPE_SLOP &&
          Math.abs(motion.dx) > Math.abs(motion.dy) * 1.5;
      },
      onStartShouldSetPanResponder: (event) =>
        touches(event).length > 1 || zoomRef.current.scale > 1,
      onMoveShouldSetPanResponder: (event) =>
        touches(event).length > 1 || zoomRef.current.scale > 1,
      onPanResponderGrant: (event) => {
        const points = touches(event);
        const a = points[0];
        const b = points[1];
        if (b || zoomRef.current.scale > 1) swipeRef.current = false;
        gestureRef.current = {
          distance: a && b ? Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) : 0,
          x: a && b ? (a.pageX + b.pageX) / 2 : (a?.pageX ?? 0),
          y: a && b ? (a.pageY + b.pageY) / 2 : (a?.pageY ?? 0),
          start: zoomRef.current,
        };
      },
      onPanResponderStart: (event) => {
        if (touches(event).length > 1) swipeRef.current = false;
      },
      onPanResponderMove: (event) => {
        const points = touches(event);
        const a = points[0];
        const b = points[1];
        if (b) swipeRef.current = false;
        const start = gestureRef.current;
        if (!a) return;
        if (swipeRef.current) {
          swipeMotionRef.current.dx = a.pageX - swipeMotionRef.current.x;
          swipeMotionRef.current.dy = a.pageY - swipeMotionRef.current.y;
        }
        if (b && start.distance === 0) {
          gestureRef.current = {
            distance: Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY),
            x: (a.pageX + b.pageX) / 2,
            y: (a.pageY + b.pageY) / 2,
            start: zoomRef.current,
          };
          return;
        }
        if (b && start.distance > 0) {
          const distance = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
          const midpointX = (a.pageX + b.pageX) / 2;
          const midpointY = (a.pageY + b.pageY) / 2;
          const next = zoomImageAt(
            start.start,
            (start.start.scale * distance) / start.distance,
            center(),
            frameRef.current,
          );
          setImageZoom(
            clampImageZoom(
              { ...next, x: next.x + midpointX - start.x, y: next.y + midpointY - start.y },
              frameRef.current,
            ),
          );
        } else if (!b && zoomRef.current.scale > 1) {
          if (start.distance > 0) {
            gestureRef.current = { distance: 0, x: a.pageX, y: a.pageY, start: zoomRef.current };
            return;
          }
          setImageZoom(
            clampImageZoom(
              {
                ...start.start,
                x: start.start.x + a.pageX - start.x,
                y: start.start.y + a.pageY - start.y,
              },
              frameRef.current,
            ),
          );
        }
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: () => {
        const { dx, dy } = swipeMotionRef.current;
        if (swipeRef.current && zoomRef.current.scale === 1 &&
          Math.abs(dx) >= PHOTO_SWIPE_DISTANCE &&
          Math.abs(dx) > Math.abs(dy) * 1.5) {
          swipePhotoRef.current?.(dx < 0 ? 1 : -1);
        }
        swipeRef.current = false;
        gestureRef.current.start = zoomRef.current;
      },
      onPanResponderTerminate: () => { swipeRef.current = false; },
    }),
  ).current;

  const wheel = (event: {
    preventDefault(): void;
    nativeEvent: { deltaY: number; offsetX?: number; offsetY?: number };
  }) => {
    event.preventDefault();
    const { width, height } = frameRef.current;
    const focal = {
      x: (event.nativeEvent.offsetX ?? width / 2) - width / 2,
      y: (event.nativeEvent.offsetY ?? height / 2) - height / 2,
    };
    setImageZoom(
      zoomImageAt(
        zoomRef.current,
        zoomRef.current.scale * Math.exp(-event.nativeEvent.deltaY * 0.002),
        focal,
        frameRef.current,
      ),
    );
  };

  return (
    <YStack flex={1}>
      <YStack
        flex={1}
        overflow="hidden"
        touchAction={Platform.OS === 'web' ? 'none' : undefined}
        onLayout={(event) => {
          frameRef.current = { ...frameRef.current, ...event.nativeEvent.layout };
          setImageZoom(clampImageZoom(zoomRef.current, frameRef.current));
        }}
        testID={`${testIDPrefix}-image-viewport`}
        {...(gesture.panHandlers as object)}
        {...(Platform.OS === 'web' ? ({ onWheel: wheel } as object) : {})}
      >
        <YStack
          accessibilityLabel={`Image ${title}`}
          // Tamagui's press events honour delayLongPress on native; its stack types omit it.
          {...({ delayLongPress: 450 } as object)}
          onLongPress={() => {
            swipeRef.current = false;
            showPictureActions(attachment);
          }}
          width="100%"
          height="100%"
          x={zoom.x}
          y={zoom.y}
          scale={zoom.scale}
          testID={`${testIDPrefix}-image-actions`}
          {...(Platform.OS === 'web'
            ? {
                onContextMenu: (event: { preventDefault(): void }) => {
                  event.preventDefault();
                  showPictureActions(attachment);
                },
              }
            : {})}
        >
          <ArtifactImage
            key={attachment.url}
            attachment={attachment}
            fit="contain"
            onLoadImageSize={(imageWidth, imageHeight) => {
              if (!liveRef.current || attachmentRef.current !== attachment) return;
              frameRef.current = { ...frameRef.current, imageWidth, imageHeight };
              setImageZoom(clampImageZoom(zoomRef.current, frameRef.current));
            }}
            testID={`${testIDPrefix}-image`}
          />
        </YStack>
      </YStack>
      <ZoomBar
        scale={zoom.scale}
        canZoomIn={zoom.scale < MAX_IMAGE_ZOOM}
        onZoomOut={() => step(1 / 1.5)}
        onZoomIn={() => step(1.5)}
        onReset={() => setImageZoom({ scale: 1, x: 0, y: 0 })}
        testIDPrefix={testIDPrefix}
      />
    </YStack>
  );
}
