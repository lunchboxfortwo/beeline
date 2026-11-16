import { Platform } from 'react-native';
import { loadBuzzViewerPubkey } from '@/auth/buzz-identity-storage';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { loadLastPage, saveLastPage } from '@/sync/persistence';
import { setRestoredPage, observeRestoredPage } from './restored-page';

// Only durable pages belong here. In particular, callbacks, invites, creation
// flows, payment/sign-in ceremonies and viewers backed by temporary data do not.
const pages: Record<string, readonly string[]> = {
  '/': ['communityId'],
  '/beeline/channels': ['communityId'],
  '/beeline/tray': ['communityId'],
  '/beeline/people': ['communityId'],
  '/beeline/members': ['roomId', 'communityId'],
  '/beeline/human-profile': ['memberId', 'workspaceId', 'communityId'],
  '/beeline/agent-profile': ['agentId', 'workspaceId', 'communityId', 'roomId'],
  '/beeline/chat-info': ['roomId'],
  '/beeline/brief': ['roomId'],
  '/beeline/workflow': ['roomId', 'name'],
  '/beeline/workflow-run': ['roomId', 'runId'],
  '/beeline/settings': [],
  '/beeline/settings/identity': [],
  '/beeline/settings/workspace': ['communityId'],
  '/beeline/settings/schedules': ['roomId', 'workspaceId'],
  '/beeline/settings/schedule': ['scheduleId', 'roomId'],
  '/beeline/settings/subscription': ['roomId', 'subscriptionId'],
  '/beeline/settings/workflows': ['roomId'],
  '/beeline/settings/workbench': ['workspaceId', 'viewerId'],
  '/beeline/settings/workbench/connection': ['workspaceId', 'viewerId', 'connectionId'],
  '/beeline/settings/workbench/app': ['workspaceId', 'viewerId', 'appId'],
  '/beeline/settings/workbench/service': ['workspaceId', 'viewerId', 'helperId', 'service'],
  '/beeline/settings/workbench/wallet': ['workspaceId', 'viewerId'],
  '/changelog': [],
};

const required: Record<string, readonly string[]> = {
  '/beeline/human-profile': ['memberId'],
  '/beeline/agent-profile': ['agentId'],
  '/beeline/chat-info': ['roomId'],
  '/beeline/brief': ['roomId'],
  '/beeline/workflow': ['roomId', 'name'],
  '/beeline/workflow-run': ['roomId', 'runId'],
  '/beeline/settings/schedule': ['roomId', 'scheduleId'],
  '/beeline/settings/subscription': ['roomId', 'subscriptionId'],
  '/beeline/settings/workbench/connection': ['workspaceId', 'viewerId', 'connectionId'],
  '/beeline/settings/workbench/app': ['workspaceId', 'viewerId', 'appId'],
  '/beeline/settings/workbench/service': ['workspaceId', 'viewerId', 'service'],
  '/beeline/settings/workbench/wallet': ['workspaceId'],
};

export function durablePage(pathname: string, params: Record<string, unknown>): string | null {
  try { decodeURIComponent(pathname); } catch { return null; }
  const keys = /^\/beeline\/chat\/[^/]+$/.test(pathname)
    ? ['communityId', 'parent'] : pages[pathname];
  if (!keys) return null;
  const query = new URLSearchParams();
  for (const key of keys) {
    const value = Array.isArray(params[key]) ? params[key][0] : params[key];
    if (typeof value === 'string' && value) query.set(key, value);
  }
  if (required[pathname]?.some(key => !query.has(key))) return null;
  return `${pathname}${query.size ? `?${query}` : ''}`;
}

function parsePage(raw: string | null): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null;
  try {
    const url = new URL(raw, 'beeline://page');
    return durablePage(url.pathname, Object.fromEntries(url.searchParams));
  } catch { return null; }
}

async function accountScope(): Promise<string | null> {
  const viewer = await loadBuzzViewerPubkey();
  return viewer ? JSON.stringify([getBuzzRuntimeConfig().monolithUrl, viewer]) : null;
}

/** Native intent runs before any screen mounts, so the deck cannot flash.
 * Expo Router installs this as the initial destination, with no saved stack. */
export async function restoreLastPage(path: string): Promise<string> {
  setRestoredPage(null);
  if (Platform.OS === 'web' || !['', '/', 'beeline://', 'beeline:///'].includes(path)) return path;
  try {
    const scope = await accountScope();
    const page = scope ? parsePage(loadLastPage(scope)) : null;
    if (!scope || !page) return path;
    setRestoredPage(page, () => { try { saveLastPage(scope, null); } catch { /* Best effort. */ } });
    return page;
  } catch { return path; }
}

/** Called only for committed Expo routes; superseded async identity reads cancel. */
export async function rememberLastPage(pathname: string, params: Record<string, unknown>, current: () => boolean): Promise<void> {
  if (Platform.OS === 'web') return;
  observeRestoredPage(pathname);
  const page = durablePage(pathname, params);
  if (!page) return;
  try {
    const scope = await accountScope();
    if (scope && current()) saveLastPage(scope, page);
  } catch { /* Local navigation must work when device storage is unavailable. */ }
}

