import React from 'react';
import { PixelRatio, type ImageProps } from 'react-native';
import { PixelImage } from '@/ui/grammar';

export type RepositoryImageProps = ImageProps & { size: number; homepage: boolean };

/** The icon endpoint rasterizes SVG and scales with nearest-neighbor at device resolution.
 *  Every platform draws it pixel-sharp. */
export function RepositoryImage({ size, homepage, source, ...props }: RepositoryImageProps) {
  if (homepage && source && !Array.isArray(source) && typeof source === 'object' && source.uri) {
    const url = new URL(source.uri);
    url.searchParams.set('size', String(PixelRatio.getPixelSizeForLayoutSize(size)));
    source = { ...source, uri: url.href, width: size, height: size, scale: PixelRatio.get() };
  }
  return <PixelImage {...props} source={source} resizeMethod="scale" />;
}
