import { authPhase, observeAuth } from './auth-diagnostics';
import { beginFunnelAttempt, funnelCallback } from './signin-funnel';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { isDesktopShell } from '@/utils/isDesktopShell';

interface AuthSessionResult {
  type: string;
  url?: string;
}

interface AuthUrlSubscription {
  remove(): void;
}

export async function initialAuthUrl(): Promise<string | null> {
  if (!isDesktopShell()) return Linking.getInitialURL();
  const { getCurrent } = await import('@tauri-apps/plugin-deep-link');
  return (await getCurrent())?.find((url) => url.startsWith('beeline://')) ?? null;
}

export async function openAccountAuthSession(
  authorizationUrl: string,
  redirectUri: string,
  options: Record<string, unknown>,
): Promise<AuthSessionResult> {
  // OIDC uses the same observer when enabled. GitHub's resilient wrapper has
  // already attached its context, so repository installation is never counted.
  const url=new URL(authorizationUrl);
  const google=/^\/auth\/(?:oidc|google)\/start$/.test(url.pathname);
  if(google && !url.searchParams.has('funnel')){
    const context=await beginFunnelAttempt('google').catch(()=>undefined);
    if(context)url.searchParams.set('funnel',JSON.stringify(context));
  }
  try {
    if (!isDesktopShell()) {
      const result=await authPhase('browser_open_requested', () => WebBrowser.openAuthSessionAsync(url.toString(), redirectUri, options));
      observeAuth({ name: 'browser_returned', outcome: result.type === 'success' ? 'success' : result.type === 'cancel' ? 'cancelled' : 'unknown' });
      if(google && result.type==='success') {
        const error=new URL(result.url).searchParams.get('error');
        void funnelCallback(error ? 'error' : 'success',error ? 'provider_error' : undefined);
      }
      // The sign-in flow checks server completion before recording a close outcome.
      return result;
    }
    const { invoke } = await import('@tauri-apps/api/core');
    await authPhase('browser_open_requested', () => invoke('desktop_open_auth_url', { url: url.toString() }), 'browser_opened');
    return { type: 'opened' };
  }catch(error){if(google)void funnelCallback('error','unknown');throw error;}
}

export function subscribeToAuthUrls(
  listener: (url: string) => void,
): AuthUrlSubscription | Promise<AuthUrlSubscription> {
  const received = (url: string) => { observeAuth({ name: 'callback_received' }); listener(url); };
  if (!isDesktopShell()) {
    const subscription=Linking.addEventListener('url', ({ url }) => received(url));
    observeAuth({ name: 'listener_ready' });
    return subscription;
  }
  return import('@tauri-apps/plugin-deep-link').then(async ({ onOpenUrl }) => {
    const unlisten = await onOpenUrl((urls) => urls.forEach(received));
    observeAuth({ name: 'listener_ready' });
    return { remove: unlisten };
  });
}
