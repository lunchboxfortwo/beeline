import type { ProviderAdapter } from './types.js';
export const key = 'tiktok' as const;
export const adapter: ProviderAdapter = {
  key,
  customAuthOnly: true,
  signInUnavailable:
    'TikTok sign-in is waiting on TikTok’s approval of Beeline. There is no working sign-in card yet.',
};
