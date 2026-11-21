import * as React from 'react';
import { PostHogProvider, tracking } from './tracking';

/** Native wraps the app in PostHog's provider when analytics is configured. */
export function TrackingRoot({ children }: { children: React.ReactNode; drawn: boolean }) {
    return tracking ? <PostHogProvider client={tracking}>{children}</PostHogProvider> : <>{children}</>;
}
