import { beforeEach, expect, it, vi } from 'vitest';
import type { DiagnosticStep } from '@beeline/api-contract/diagnostics';
const controls=vi.hoisted(()=>({steps:[] as DiagnosticStep[],open:vi.fn(),desktop:false}));
vi.mock('@/track/diagnostics',()=>({authDiagnostic:(step:DiagnosticStep)=>{controls.steps.push(step);},diagnosticIdentity:vi.fn()}));
vi.mock('@/auth/signin-funnel',()=>({funnelSignedIn:vi.fn(),beginFunnelAttempt:vi.fn(),funnelCallback:vi.fn()}));
vi.mock('./signin-funnel',()=>({funnelSignedIn:vi.fn(),beginFunnelAttempt:vi.fn(),funnelCallback:vi.fn()}));
vi.mock('expo-linking',()=>({addEventListener:vi.fn(()=>({remove:vi.fn()})),getInitialURL:async()=>null}));
vi.mock('expo-web-browser',()=>({openAuthSessionAsync:controls.open}));
vi.mock('@tauri-apps/plugin-opener',()=>({openUrl:controls.open}));
vi.mock('@/utils/isDesktopShell',()=>({isDesktopShell:()=>controls.desktop}));
vi.mock('@/buzz/runtime-config',()=>({getBuzzRuntimeConfig:()=>({monolithUrl:'https://fixture.invalid'})}));
vi.mock('@/auth/monolith-secure-storage',()=>({monolithSecureStorage:async()=>({})}));
vi.mock('@/utils/web-storage',()=>({webRuntimeStorage:()=>undefined}));
vi.mock('@/sync/client-reset',()=>({resetClientState:vi.fn()}));
import { MonolithSession } from './monolith-session';
import { openAccountAuthSession } from './desktop-auth-session';
import { authPhase, authFailureCode, setAuthDiagnosticObserver } from './auth-diagnostics';
const settle=()=>vi.waitFor(()=>expect(controls.steps.length).toBeGreaterThan(0));
beforeEach(()=>{controls.steps=[];controls.desktop=false;controls.open.mockReset();setAuthDiagnosticObserver(step=>{controls.steps.push(step);});});

it('acceptance 2: real browser opener and exchange/save failures name their actual boundary without URL or token contents',async()=>{
  controls.desktop=true;controls.open.mockRejectedValue(new Error('private provider URL and body'));
  await expect(openAccountAuthSession('https://fixture.invalid/auth/github/start?token=private','beeline://callback',{})).rejects.toThrow('private provider URL and body');
  await settle();
  await vi.waitFor(()=>expect(controls.steps).toContainEqual(expect.objectContaining({name:'auth_failed',phase:'browser_open_requested',code:'browser_open_failed'})));
  controls.steps=[];
  const secure={getItemAsync:async()=>null,setItemAsync:async()=>{throw new Error('credential value must never enter telemetry');},deleteItemAsync:async()=>{}};
  const exchange=new MonolithSession('https://fixture.invalid',async()=>new Response(JSON.stringify({accessToken:'private-access',refreshToken:'private-refresh',identityId:'a'.repeat(64),accessExpiresAt:Date.now()+1000})),async()=>secure);
  await expect(exchange.exchangeGoogleTicket('private-ticket')).rejects.toThrow();
  await vi.waitFor(()=>expect(controls.steps).toContainEqual(expect.objectContaining({name:'auth_failed',phase:'session_saved',code:'storage_failed'})));
  expect(controls.steps).toContainEqual(expect.objectContaining({name:'exchange_completed',outcome:'success'}));
  for(const text of ['private-access','private-refresh','private-ticket','credential value','https://']) expect(JSON.stringify(controls.steps)).not.toContain(text);
});

it.each([
  [new TypeError('network unavailable'),'offline'],
  [Object.assign(new Error('timeout'),{name:'AbortError'}),'timeout'],
  [null,'refused'],
] as const)('acceptance 2: exchange transport/refusal is distinct from callback success (%s)',async(error,code)=>{
  const session=new MonolithSession('https://fixture.invalid',async()=>{if(error)throw error;return new Response(null,{status:403});},async()=>({getItemAsync:async()=>null,setItemAsync:async()=>{},deleteItemAsync:async()=>{}}));
  await expect(session.exchangeGitHubTicket('secret')).rejects.toThrow();
  await vi.waitFor(()=>expect(controls.steps).toContainEqual(expect.objectContaining({name:'auth_failed',phase:'exchange_started',code})));
  expect(controls.steps.some(s=>s.name==='session_saved')).toBe(false);
});

it('acceptance 2: cancelled, denied, invalid callback and navigation failure stay explicit',async()=>{
  expect(authFailureCode({code:'browser_canceled'},'browser_returned')).toBe('browser_canceled');
  expect(authFailureCode({code:'oidc_denied'},'callback_validated')).toBe('provider_denied');
  expect(authFailureCode({code:'state_mismatch'},'callback_validated')).toBe('invalid_callback');
  expect(authFailureCode({code:'callback_missing'},'recovery_started')).toBe('callback_missing');
  await expect(authPhase('navigation_started',async()=>{throw new Error('route private value');})).rejects.toThrow();
  await vi.waitFor(()=>expect(controls.steps).toContainEqual(expect.objectContaining({phase:'navigation_started',code:'navigation_failed'})));
});
