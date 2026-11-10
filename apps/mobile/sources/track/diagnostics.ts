import { sendAnonymousDiagnostics } from '@/auth/anonymous-diagnostics';
import { setAuthDiagnosticObserver } from '@/auth/auth-diagnostics';
import * as Updates from 'expo-updates';
import { loadAppConfig } from '@/sync/appConfig';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
import { AppState, Platform } from 'react-native';
import { createDiagnosticClient } from '@beeline/api-contract/diagnostics-client';
import type { DiagnosticBatch, DiagnosticStep, DiagnosticAck } from '@beeline/api-contract/diagnostics';
import { isDesktopShell } from '@/utils/isDesktopShell';

let client: ReturnType<typeof createDiagnosticClient> | undefined;
let socket: { ready(): boolean; send(batch: DiagnosticBatch): Promise<DiagnosticAck> } | undefined;
export function attachDiagnosticSocket(connection: NonNullable<typeof socket>): void { socket=connection; }
function getClient() {
  if (client) return client;
  const desktop = isDesktopShell();
  const os = globalThis.navigator?.platform ?? '';
  const platform = desktop ? /mac/i.test(os) ? 'macos' : /win/i.test(os) ? 'windows' : 'linux'
    : Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
  const release=loadAppConfig();
  const ua=globalThis.navigator?.userAgent ?? '';
  const browser = /Edg\//.test(ua) ? 'edge' : /Firefox\//.test(ua) ? 'firefox' : /Chrome\//.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : 'unknown';
  const browserVersion=ua.match(/(?:Edg|Firefox|Chrome|Version)\/(\d+(?:\.\d+)*)/)?.[1];
  client = createDiagnosticClient({ storage: AsyncStorage,uuid: randomUUID,
    descriptor: { platform,client: desktop ? 'tauri' : platform === 'web' ? 'web' : 'expo_native',
      version: Constants.expoConfig?.version ?? '0',
      environment: typeof __DEV__ !== 'undefined' && __DEV__ ? 'development' : 'production',
      ...(/^\d[\d.]*$/.test(String(Platform.Version)) ? { osVersion: String(Platform.Version) } : {}),
      ...(platform==='web' || desktop ? {browser,...(browserVersion?{browserVersion}:{})} : {}),
      ...(Updates.runtimeVersion && /^\d/.test(Updates.runtimeVersion) ? {runtimeVersion:Updates.runtimeVersion} : {}),
      ...(Updates.updateId ? {updateId:Updates.updateId} : {}),
      ...(release.releaseSha && /^[a-f0-9]{40}$/.test(release.releaseSha) ? {releaseSha:release.releaseSha} : {}),
    },
    send: async (batch,authenticated,owner) => {
      if (authenticated) {
        const { monolithSession } = await import('@/auth/monolith-session');
        const current=await monolithSession.identityId();
        if (current!==owner) { diagnosticIdentity(current); throw new Error('identity_changed'); }
        if (!socket?.ready()) throw new Error('offline');
        return socket.send(batch);
      }
      // Existing funnel owns the only pre-auth HTTP sender. Its registration is synchronous.
      return sendAnonymousDiagnostics(batch);
    },
  });
  return client;
}
export function diagnostic(step: DiagnosticStep): void {
  void getClient().record(step).catch(()=>undefined);
}
export async function identifyDiagnostics(identity: string | null): Promise<void> {
  const attemptId = await AsyncStorage.getItem(ATTEMPT).catch(()=>null);
  await getClient().identify(identity,attemptId ?? undefined);
  if (identity===null) await AsyncStorage.removeItem(ATTEMPT).catch(()=>undefined);
}
export function diagnosticIdentity(identity: string | null): void {
  void identifyDiagnostics(identity).then(()=>getClient().flush()).catch(()=>undefined);
}
export function flushDiagnostics(): void { void getClient().flush().catch(()=>undefined); }
export function diagnosticOrigin() {
  const origin=getClient().contextNow();
  return origin ? { ...origin,requestId:randomUUID() } : undefined;
}

const ATTEMPT = 'beeline.diagnostics.auth-attempt.v1';
export async function diagnosticAttempt(attemptId: string): Promise<void> {
  await AsyncStorage.setItem(ATTEMPT,attemptId).catch(()=>undefined);
  diagnostic({ name: 'auth_started',attemptId });
}
export async function authDiagnostic(step: DiagnosticStep): Promise<void> {
  const attemptId = await AsyncStorage.getItem(ATTEMPT).catch(()=>null);
  diagnostic({ ...step,...(attemptId ? { attemptId } : {}) });
}

setAuthDiagnosticObserver(authDiagnostic);

/** Root-owned lifecycle includes the pre-auth browser handoff, before any socket exists. */
export function startDiagnosticLifecycle(): () => void {
  diagnostic({name:AppState.currentState==='background'?'background':'foreground'});
  const listener=AppState.addEventListener('change',state=>{
    if(state!=='active' && state!=='background')return;
    diagnostic({name:state==='active'?'foreground':'background'});
    flushDiagnostics();
  });
  return ()=>listener.remove();
}
