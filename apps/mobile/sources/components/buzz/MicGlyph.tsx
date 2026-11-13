import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';

export const MIC_GLYPH_STROKE_WIDTH = 1.6;

/** The composer's control glyph size, shared with its loaders. */
export const COMPOSER_GLYPH_SIZE = 20;

function StrokeGlyph({ ink, testID, size = COMPOSER_GLYPH_SIZE, children }: { ink: string; testID?: string; size?: number; children: React.ReactNode }) {
  return <Svg {...DECORATIVE_GLYPH_PROPS} width={size} height={size}
    viewBox="0 0 20 20" testID={testID} fill="none" stroke={ink} strokeWidth={MIC_GLYPH_STROKE_WIDTH}
    strokeLinecap="round" strokeLinejoin="round">
    {children}
  </Svg>;
}

/** Viewer conversation, shared by the dock and message provenance. */
export function ConversationGlyph({ color, testID, size }: { color: string; testID?: string; size?: number }) {
  return <StrokeGlyph ink={color} testID={testID} size={size}>
    <Path d="M4 3h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9.5L6 17v-3H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
  </StrokeGlyph>;
}
