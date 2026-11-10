import { installWebChunkRecovery, recoverWebChunk } from './web-chunk-recovery';

installWebChunkRecovery();

// This SDK records errors only: no breadcrumbs, sessions or performance traces.
// Keep its integrations outside healthy launches, retaining early failures until
// the same SDK and privacy filter have loaded. Native keeps its eager startup.
let segments: readonly string[] = [];
let loading: Promise<typeof import('./sentry') | undefined> | undefined;
const enabled = Boolean(process.env.EXPO_PUBLIC_SENTRY_DSN) && !__DEV__;

function load() {
  return loading ??= import('./sentry').then((sdk) => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    sdk.setMobileErrorRoute(segments);
    return sdk;
  }).catch(() => undefined);
}

export function setMobileErrorRoute(next: readonly string[]): void {
  segments = [...next];
  if (loading) void loading.then((sdk) => sdk?.setMobileErrorRoute(segments));
}

export function captureMobileError(scope: string, cause: unknown): void {
  if (!enabled || recoverWebChunk(cause)) return;
  const route = segments;
  void load().then((sdk) => {
    if (!sdk) return;
    sdk.setMobileErrorRoute(route);
    sdk.captureMobileError(scope, cause);
    sdk.setMobileErrorRoute(segments);
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
