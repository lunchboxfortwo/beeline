import type { DiagnosticCode, DiagnosticName, DiagnosticStep } from '@beeline/api-contract/diagnostics';

/** Deliberately excludes Error.message, provider bodies and callback material. */
export function authFailureCode(error: unknown, phase: DiagnosticName): DiagnosticCode {
  const e = error as { code?: string; name?: string; status?: number } | null;
  if (e?.name === 'AbortError' || e?.name === 'MonolithRequestTimeoutError') return 'timeout';
  if (e?.code === 'browser_canceled') return 'browser_canceled';
  if (e?.code === 'oidc_denied' || e?.code === 'github_denied' || e?.code === 'access_denied') return 'provider_denied';
  if (['state_mismatch','wrong_provider','invalid_oidc_proof','invalid_response'].includes(e?.code ?? '')) return 'invalid_callback';
  if (e?.code === 'callback_missing') return 'callback_missing';
  if (phase === 'browser_open_requested') return 'browser_open_failed';
  if (phase === 'session_saved') return 'storage_failed';
  if (phase === 'navigation_started') return 'navigation_failed';
  if (e?.name === 'MonolithSessionRequiredError' || (e?.status && e.status < 500)) return 'refused';
  if (e?.name === 'TypeError' || e?.code === 'offline') return 'offline';
  return phase === 'exchange_started' ? 'exchange_failed' : 'unexpected_error';
}
let observer: ((step:DiagnosticStep)=>void|Promise<void>) | undefined;
let loading: Promise<unknown> | undefined;
const pending: DiagnosticStep[]=[];
export function setAuthDiagnosticObserver(next: NonNullable<typeof observer>): void {
  observer=next;
  for(const step of pending.splice(0))observeAuth(step);
}
export function observeAuth(step: DiagnosticStep): void {
  if (!observer) {
    pending.push(step);
    loading ??= import('@/track/diagnostics').catch(()=>undefined);
    return;
  }
  try { void Promise.resolve(observer(step)).catch(()=>undefined); } catch { /* Observations cannot change authentication. */ }
}
export async function authPhase<T>(phase: DiagnosticName, work: () => Promise<T>, complete?: DiagnosticName): Promise<T> {
  observeAuth({ name: phase, outcome: 'started' });
  try {
    const result = await work();
    if (complete) observeAuth({ name: complete, outcome: 'success' });
    return result;
  } catch (error) {
    const code = authFailureCode(error,phase);
    observeAuth({ name: 'auth_failed', phase, code, outcome: code === 'browser_canceled' ? 'cancelled' : 'failed' });
    throw error;
  }
}
