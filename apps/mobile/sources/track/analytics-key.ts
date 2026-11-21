import { config } from '@/config';

const analyticsDisabled =
    process.env.EXPO_PUBLIC_DISABLE_ANALYTICS === '1' ||
    process.env.EXPO_PUBLIC_DISABLE_ANALYTICS === 'true';

/** The PostHog project key, or null when this build sends no analytics. */
export const postHogKey = !analyticsDisabled && config.postHogKey ? config.postHogKey : null;
