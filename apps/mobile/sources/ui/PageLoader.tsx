import React from 'react';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';

/** The shared full-page loading state; inline loading keeps its own control. */
export function PageLoader(props: Pick<React.ComponentProps<typeof SurfaceGlyphLoader>, 'testID' | 'onLayout'>) {
    return <SurfaceGlyphLoader {...props} />;
}
