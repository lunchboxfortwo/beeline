import type { Href } from 'expo-router';

const BEELINE_WEB_HOSTS = new Set([
  'web.usebeeline.app',
  'app.usebeeline.app',
  'usebeeline.app',
]);

const CHAT_QUERY_KEYS = [
  'parent',
  'title',
  'communityId',
  'notificationMessageId',
  'notificationResponseId',
] as const;

const TRAY_QUERY_KEYS = ['communityId', 'chatId'] as const;

function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}

function pickParams(
  searchParams: URLSearchParams,
  keys: readonly string[],
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const key of keys) {
    const value = searchParams.get(key)?.trim();
    if (value) params[key] = value;
  }
  return params;
}

/**
 * Parse a Beeline web or deep-link URL into an in-app Expo Router Href.
 * Returns null for OAuth callbacks, static web pages, media downloads, and external hosts.
 */
export function beelineUrlHref(rawUrl: string): Href | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  let pathname: string;
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
    if (!BEELINE_WEB_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    pathname = parsed.pathname;
  } else if (parsed.protocol === 'beeline:') {
    pathname = parsed.hostname ? `/${parsed.hostname}${parsed.pathname}` : parsed.pathname;
  } else {
    return null;
  }

  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 3 && segments[0] === 'beeline' && segments[1] === 'chat') {
    const channelId = decodeSegment(segments[2]!);
    if (!channelId) return null;
    const params = {
      channelId,
      ...pickParams(parsed.searchParams, CHAT_QUERY_KEYS),
    };
    return { pathname: '/beeline/chat/[channelId]', params } as unknown as Href;
  }

  if (segments.length === 2 && segments[0] === 'beeline' && segments[1] === 'tray') {
    const params = pickParams(parsed.searchParams, TRAY_QUERY_KEYS);
    return (
      Object.keys(params).length
        ? { pathname: '/beeline/tray', params }
        : { pathname: '/beeline/tray' }
    ) as unknown as Href;
  }

  if (segments.length === 2 && segments[0] === 'beeline' && segments[1] === 'channels') {
    const params = pickParams(parsed.searchParams, ['communityId']);
    return (
      Object.keys(params).length
        ? { pathname: '/beeline/channels', params }
        : { pathname: '/beeline/channels' }
    ) as unknown as Href;
  }

  if (segments.length === 2 && segments[0] === 'join') {
    const token = decodeSegment(segments[1]!);
    if (!token) return null;
    return { pathname: '/join/[token]', params: { token } } as unknown as Href;
  }

  return null;
}
