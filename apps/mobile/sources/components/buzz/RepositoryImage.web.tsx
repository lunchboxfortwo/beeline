import React from 'react';
import { Image, type ImageStyle } from 'react-native';
import type { RepositoryImageProps } from './RepositoryImage';

/** Also used by the desktop webview. Native requests an icon at device resolution. */
export function RepositoryImage({ size: _size, homepage: _homepage, style, ...props }: RepositoryImageProps) {
  return <Image {...props} style={[style, { imageRendering: 'pixelated' } as ImageStyle]} />;
}
