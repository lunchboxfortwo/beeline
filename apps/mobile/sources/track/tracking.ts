import PostHog, { PostHogProvider, useNavigationTracker } from 'posthog-react-native';
import { postHogKey } from './analytics-key';

export { PostHogProvider, useNavigationTracker };

export const tracking = postHogKey ? new PostHog(postHogKey, {
    host: 'https://us.i.posthog.com',
    captureAppLifecycleEvents: true,
}) : null;
