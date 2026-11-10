import type { ProviderAdapter } from './types.js';
export const key = 'googlesheets' as const;
export const adapter: ProviderAdapter = { key, aliases: ['sheets'] };
