import React from 'react';
import { Platform } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';
import beelineMark from '@/buzz/beeline-mark.json';
import { useTheme } from 'tamagui';

// The original continuous-line loop — canonical geometry (see sources/assets/images/mark.svg,
// do not redesign). The group transform places the path on its 240-unit canvas.
const MARK_PATH = beelineMark.path;
const MARK_VIEWBOX = beelineMark.viewBox;
const MARK_TRANSFORM = beelineMark.transform;
const MARK_FILL_RULE = beelineMark.fillRule as 'evenodd' | 'nonzero';

// Canonical path's visible bounds, so the welcome sizes the ink rather than its padding.
const INK_BOX = { x: 74, y: 60, w: 100, h: 126 };

export function BeelineMark({ size = 112, tight = false }: { size?: number; tight?: boolean }) {
  const ink = useTheme().ink?.val;

  return (
    <Svg
      // `accessible` is a native-only View prop: react-native-svg forwards it to
      // the DOM on web, where React rejects `accessible={true}` as a non-boolean
      // attribute. Web gets the same public contract in DOM terms — one element
      // named as an image; native keeps the prop it actually understands.
      {...(Platform.OS === 'web'
        ? { role: 'img' as const, 'aria-label': 'Beeline logo' }
        : { accessible: true, accessibilityLabel: 'Beeline logo' })}
      width={tight ? Math.round((size * INK_BOX.w) / INK_BOX.h) : size}
      height={size}
      viewBox={tight ? `${INK_BOX.x} ${INK_BOX.y} ${INK_BOX.w} ${INK_BOX.h}` : MARK_VIEWBOX}
    >
      <G transform={MARK_TRANSFORM}>
        <Path
          d={MARK_PATH}
          fillRule={MARK_FILL_RULE}
          fill={ink}
        />
      </G>
    </Svg>
  );
}
