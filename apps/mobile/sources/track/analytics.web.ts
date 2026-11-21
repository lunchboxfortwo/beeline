import type { PostHog } from 'posthog-react-native';
import { postHogKey } from './analytics-key';

// Web keeps PostHog out of the startup bundle. TrackingRoot starts it after
// the first screen draws; events captured before then wait for the client.
let start: () => void = () => {};
const drawn = new Promise<void>((resolve) => { start = resolve; });
let loading: Promise<typeof import('./tracking')> | undefined;

export function loadTracking(): Promise<typeof import('./tracking')> {
    return loading ??= drawn.then(() => import('./tracking'));
}

export function startTracking(): void {
    start();
}

export const tracking = postHogKey ? {
    capture: (...args: Parameters<PostHog['capture']>) =>
        void loadTracking().then((loaded) => loaded.tracking?.capture(...args)).catch(() => undefined),
    screen: (...args: Parameters<PostHog['screen']>) =>
        void loadTracking().then((loaded) => loaded.tracking?.screen(...args)).catch(() => undefined),
} : null;
