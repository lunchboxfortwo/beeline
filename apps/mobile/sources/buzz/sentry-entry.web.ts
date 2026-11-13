import { installWebChunkRecovery, recoverWebChunk } from './web-chunk-recovery';

installWebChunkRecovery();

// This SDK records errors only: no breadcrumbs, sessions or performance traces.
// Keep its integrations outside healthy launches, retaining early failures until
// the same SDK and privacy filter have loaded. Native keeps its eager startup.
let segments: readonly string[] = [];
let user: string | null = null;
let loading: Promise<typeof import('./sentry') | undefined> | undefined;
const enabled = Boolean(process.env.EXPO_PUBLIC_SENTRY_DSN) && !__DEV__;

function load() {
  return loading ??= import('./sentry').then((sdk) => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    sdk.setMobileErrorRoute(segments);
    sdk.setMobileErrorUser(user);
    return sdk;
  }).catch(() => undefined);
}

export function setMobileErrorRoute(next: readonly string[]): void {
  segments = [...next];
  if (loading) void loading.then((sdk) => sdk?.setMobileErrorRoute(segments));
}

export function setMobileErrorUser(identityId: string | null): void {
  user = identityId;
  if (loading) void loading.then((sdk) => sdk?.setMobileErrorUser(user));
}

export function captureMobileError(scope: string, cause: unknown): void {
  if (!enabled || recoverWebChunk(cause)) return;
  // Snapshot the route and account now; the SDK may finish loading after a switch or sign-out.
  const route = segments, account = user;
  void load().then((sdk) => {
    if (!sdk) return;
    sdk.setMobileErrorRoute(route);
    sdk.setMobileErrorUser(account);
    sdk.captureMobileError(scope, cause);
    sdk.setMobileErrorRoute(segments);
    sdk.setMobileErrorUser(user);
  });
}

function onError(event: ErrorEvent) {
  if (event.defaultPrevented || (!event.error && !event.message)) return;
  captureMobileError('app', event.error ?? new Error(event.message));
}

function onRejection(event: PromiseRejectionEvent) {
  if (!event.defaultPrevented) captureMobileError('app', event.reason);
}

if (enabled && typeof window !== 'undefined') {
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
}
