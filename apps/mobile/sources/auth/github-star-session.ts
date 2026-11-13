import * as Linking from 'expo-linking';
import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { isDesktopShell } from '@/utils/isDesktopShell';
import { authSessionOptions } from './auth-session';
import { desktopAuthRedirectUri } from './desktop-auth-redirect';
import { openAccountAuthSession, subscribeToAuthUrls } from './desktop-auth-session';
import { waitForAuthCallbackResult } from './onboarding-state';

export function githubStarRedirectUri(roomId: string): string {
  const path = `chat/${encodeURIComponent(roomId)}`;
  return desktopAuthRedirectUri(path, Linking.createURL(`beeline/${path}`));
}

/** The server stars before returning; no client token or repository-page handoff. */
export async function authorizeGitHubStar(url: string, redirectUri: string): Promise<boolean> {
  // Older servers returned the repository itself for `open`. Never follow that fallback.
  if (new URL(url).pathname !== '/login/oauth/authorize') throw new Error('GitHub authorization is required');
  const result = await waitForAuthCallbackResult({
    redirectUri,
    openAuthSession: () => isDesktopShell()
      ? openAccountAuthSession(url, redirectUri, authSessionOptions(Platform.OS, redirectUri))
      : WebBrowser.openAuthSessionAsync(url, redirectUri, authSessionOptions(Platform.OS, redirectUri)),
    subscribeToUrls: subscribeToAuthUrls,
  });
  return new URL(result.url).searchParams.get('githubStar') === 'starred';
}
