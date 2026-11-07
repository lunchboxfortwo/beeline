import { FUNNEL_SCREENS, type FunnelScreen } from './signin-funnel.js';

/** Content-free facts only. Never add arbitrary properties or error messages. */
export const DIAGNOSTIC_EVENTS = [
  'session_started', 'session_bound', 'foreground', 'background', 'screen_viewed', 'notice_shown',
  'operation_started', 'operation_completed', 'operation_failed',
  'auth_started', 'provider_picker_started', 'provider_picker_completed', 'browser_open_requested', 'browser_opened', 'browser_returned',
  'listener_ready', 'callback_received', 'recovery_started', 'recovery_completed',
  'callback_validated', 'exchange_started', 'exchange_completed', 'session_saved',
  'navigation_started', 'navigation_committed', 'auth_failed',
  'workspace_created', 'agent_command', 'agent_terminal', 'mcp_delivery',
  'ota_update_available', 'ota_update_applied', 'coverage',
] as const;
export type DiagnosticName = typeof DIAGNOSTIC_EVENTS[number];
export const DIAGNOSTIC_CODES = [
  'browser_open_failed', 'browser_canceled', 'browser_dismissed', 'provider_denied',
  'provider_error', 'callback_missing', 'invalid_callback', 'listener_late',
  'offline', 'timeout', 'refused', 'exchange_failed', 'storage_failed',
  'navigation_failed', 'transport_failed', 'cancelled', 'unexpected_error',
  'storage_unavailable', 'legacy_context', 'host_execution_unknown',
  'access_ended', 'http_error', 'network_error', 'telemetry_disabled',
] as const;
export type DiagnosticCode = typeof DIAGNOSTIC_CODES[number];
export type DiagnosticOutcome = 'started' | 'success' | 'failed' | 'refused' | 'cancelled' | 'unknown';
export type DiagnosticStep = {
  name: DiagnosticName;
  outcome?: DiagnosticOutcome;
  code?: DiagnosticCode;
  phase?: DiagnosticName;
  route?: FunnelScreen;
  operation?: string;
  actionId?: string;
  requestId?: string;
  attemptId?: string;
  workspaceId?: string;
  commandId?: string;
  durationMs?: number;
  httpStatus?: number;
  creationSource?: 'manual_ui' | 'onboarding' | 'mcp_consent' | 'recovery';
  deliveryState?: 'delivered' | 'failed' | 'skipped' | 'unknown';
};
export type DiagnosticDescriptor = {
  platform: 'ios' | 'android' | 'web' | 'macos' | 'windows' | 'linux';
  client: 'expo_native' | 'web' | 'tauri';
  version: string;
  environment: 'production' | 'development' | 'preview' | 'lab';
  osVersion?: string;
  releaseSha?: string;
  buildNumber?: string;
  browserVersion?: string;
  browser?: 'chrome' | 'safari' | 'firefox' | 'edge' | 'unknown';
  runtimeVersion?: string;
  updateId?: string;
};
export type DiagnosticEvent = DiagnosticStep & {
  eventId: string;
  sequence: number;
  occurredAt: string;
};
export type DiagnosticBatch = {
  schemaVersion: 1;
  deviceId: string;
  sessionId: string;
  viewId: string;
  /** Possession proves continuity, never journaled or exported. */
  bindingKey: string;
  descriptor: DiagnosticDescriptor;
  events: DiagnosticEvent[];
};
export type DiagnosticAck = { accepted: string[] };
export const DIAGNOSTIC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every(k => keys.includes(k));
const member = (v: unknown, choices: readonly string[]) => typeof v === 'string' && choices.includes(v);
const uuid = (v: unknown) => typeof v === 'string' && DIAGNOSTIC_UUID.test(v);
// Version fields contain build identifiers, never URLs, user agent strings or names.
const version = (v: unknown) => typeof v === 'string' && /^[0-9][0-9A-Za-z.+_-]{0,79}$/.test(v);
export function parseDiagnosticBatch(raw: unknown, operations: ReadonlySet<string>): DiagnosticBatch | null {
  if (!object(raw) || !only(raw, ['schemaVersion','deviceId','sessionId','viewId','bindingKey','descriptor','events']) ||
    raw.schemaVersion !== 1 || ![raw.deviceId,raw.sessionId,raw.viewId,raw.bindingKey].every(uuid) ||
    !object(raw.descriptor) || !Array.isArray(raw.events) || !raw.events.length || raw.events.length > 32) return null;
  const d = raw.descriptor;
  if (!only(d, ['platform','client','version','environment','osVersion','releaseSha','buildNumber','browserVersion','browser','runtimeVersion','updateId']) ||
    !member(d.platform,['ios','android','web','macos','windows','linux']) || !member(d.client,['expo_native','web','tauri']) ||
    !member(d.environment,['production','development','preview','lab']) || !version(d.version) ||
    (d.releaseSha !== undefined && (typeof d.releaseSha !== 'string' || !/^[a-f0-9]{40}$/.test(d.releaseSha))) ||
    (d.buildNumber !== undefined && !version(d.buildNumber)) ||
    (d.browserVersion !== undefined && !version(d.browserVersion)) ||
    (d.osVersion !== undefined && !version(d.osVersion)) || (d.runtimeVersion !== undefined && !version(d.runtimeVersion)) ||
    (d.updateId !== undefined && !uuid(d.updateId)) ||
    (d.browser !== undefined && !member(d.browser,['chrome','safari','firefox','edge','unknown']))) return null;
  const ids=new Set<string>();
  for (const e of raw.events) {
    if (!object(e) || !only(e, ['eventId','sequence','occurredAt','name','outcome','code','phase','route','operation',
      'actionId','requestId','attemptId','workspaceId','commandId','durationMs','httpStatus','creationSource','deliveryState']) ||
      !uuid(e.eventId) || !Number.isSafeInteger(e.sequence) || Number(e.sequence) < 1 ||
      typeof e.occurredAt !== 'string' || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(e.occurredAt) || !Number.isFinite(Date.parse(e.occurredAt)) ||
      !member(e.name,DIAGNOSTIC_EVENTS) || (e.phase !== undefined && !member(e.phase,DIAGNOSTIC_EVENTS)) ||
      (e.outcome !== undefined && !member(e.outcome,['started','success','failed','refused','cancelled','unknown'])) ||
      (e.code !== undefined && !member(e.code,DIAGNOSTIC_CODES)) || (e.route !== undefined && !member(e.route,FUNNEL_SCREENS)) ||
      (e.operation !== undefined && (typeof e.operation !== 'string' || !operations.has(e.operation))) ||
      ['actionId','requestId','attemptId','workspaceId'].some(k => e[k] !== undefined && !uuid(e[k])) ||
      (e.commandId !== undefined && (typeof e.commandId !== 'string' || !/^[0-9a-f]{64}$/.test(e.commandId))) ||
      (e.durationMs !== undefined && (!Number.isSafeInteger(e.durationMs) || Number(e.durationMs) < 0)) ||
      (e.httpStatus !== undefined && (!Number.isInteger(e.httpStatus) || Number(e.httpStatus)<100 || Number(e.httpStatus)>599)) ||
      (e.creationSource !== undefined && !member(e.creationSource,['manual_ui','onboarding','mcp_consent','recovery'])) ||
      (e.deliveryState !== undefined && !member(e.deliveryState,['delivered','failed','skipped','unknown']))) return null;
    if (ids.has(e.eventId as string)) return null;
    ids.add(e.eventId as string);
  }
  return raw as unknown as DiagnosticBatch;
}
