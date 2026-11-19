import React from 'react';
import { Image, type ImageProps, type ImageStyle } from 'react-native';

/** Part of the grammar, kept apart so screens and their tests do not load the
 * native Image runtime. */
const PIXELATED = { imageRendering: 'pixelated' } as ImageStyle;

/** An image drawn pixel-sharp on web, so small pixel-art icons do not blur. Native ignores the hint. */
export function PixelImage({ style, ...props }: ImageProps) {
    return <Image {...props} style={[style, PIXELATED]} />;
}
