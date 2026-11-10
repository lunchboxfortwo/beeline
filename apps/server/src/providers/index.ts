import { adapter as linear } from './linear.js';
import { adapter as stripe } from './stripe.js';
import { adapter as youtube } from './youtube.js';
import { adapter as github } from './github.js';
import { adapter as tiktok } from './tiktok.js';
import { adapter as slack } from './slack.js';
import { adapter as gmail } from './gmail.js';
import { adapter as googlesheets } from './googlesheets.js';
import { adapter as whatsapp } from './whatsapp.js';
import type { ProviderAdapter } from './types.js';

export const providers: readonly ProviderAdapter[] = [
  linear,
  stripe,
  youtube,
  github,
  tiktok,
  slack,
  gmail,
  googlesheets,
  whatsapp,
];
const registry = new Map(providers.map((adapter) => [adapter.key, adapter]));
export function providerAdapter(key: string): ProviderAdapter | undefined {
  return registry.get(key);
}
export function providerToolkit(key: string): string {
  const known: Record<string, string> = {
    calendar: 'googlecalendar',
    drive: 'googledrive',
    docs: 'googledocs',
    googlecalendar: 'googlecalendar',
    googledrive: 'googledrive',
    googledocs: 'googledocs',
  };
  return providers.find((adapter) => adapter.aliases?.includes(key))?.key ?? known[key] ?? key;
}
export function checkProviderRequestFailure(path: string, payload: unknown, message: string): void {
  for (const adapter of providers) adapter.checkRequestFailure?.(path, payload, message);
}
export const officialRegistryApps: Readonly<Record<string, string>> = Object.fromEntries(
  providers
    .filter((adapter) => adapter.officialRegistry)
    .map((adapter) => [adapter.key, adapter.officialRegistry!]),
);
export const defaultCatalogKeys = [
  gmail.key,
  'googlecalendar',
  slack.key,
  'googledrive',
  googlesheets.key,
  'notion',
  linear.key,
  'hubspot',
  'airtable',
  'asana',
  'jira',
  'supabase',
];
export type ProviderService = typeof linear.key | typeof stripe.key;
export const webhookProviders = providers.filter((adapter) => adapter.webhook);
export function providerForEvent(event: string): ProviderService | undefined {
  return webhookProviders.find((adapter) => adapter.webhook!.event === event)?.key as
    ProviderService | undefined;
}
export function providerWebhook(key: ProviderService) {
  return registry.get(key)!.webhook!;
}
export function isProviderService(key: string): key is ProviderService {
  return !!registry.get(key)?.webhook;
}

export { connectedSlackApp, slackEventAvailable, slackDeliveries } from './slack.js';
export { key as linearProviderKey } from './linear.js';
export { key as stripeProviderKey } from './stripe.js';
export { key as youtubeProviderKey } from './youtube.js';
export { key as githubProviderKey } from './github.js';
export { key as tiktokProviderKey } from './tiktok.js';
export { key as gmailProviderKey } from './gmail.js';
export { key as slackProviderKey } from './slack.js';
export { key as googlesheetsProviderKey } from './googlesheets.js';
