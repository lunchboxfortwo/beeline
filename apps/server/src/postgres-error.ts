import {queryFingerprint} from './query-profile.js';
import { fileURLToPath } from 'node:url';

const serverDirectory = fileURLToPath(new URL('../', import.meta.url));

/** Only log a relative source location from our own stack, without function
 * names, absolute paths, driver error text, SQL or parameters. */
export function postgresCallSite(caller: Error): string | undefined {
  for (const frame of caller.stack?.split('\n').slice(1) ?? []) {
    const offset = frame.indexOf(serverDirectory);
    if (offset < 0) continue;
    const location = /^(?:src|dist)\/((?:[\w-]+\/)*[\w.-]+\.[jt]s:\d+:\d+)\)?$/.exec(
      frame.slice(offset + serverDirectory.length),
    )?.[1];
    if (location && !/^(database|corner-access-database|command-scoped-database)\.[jt]s:/.test(location))
      return location;
  }
}

const statements=new WeakMap<object,string>();

/** Keep the original pg error and stack; record a fingerprint, never parameters. */
export function recordPostgresStatementError(error:unknown,sql:string):void {
  if(typeof error==='object' && error!==null && !statements.has(error))
    statements.set(error,queryFingerprint(sql));
}

export function postgresErrorContext(error:unknown):Record<string,string>|undefined {
  if(typeof error!=='object' || error===null) return;
  const {code,detail}=error as {code?:unknown;detail?:unknown};
  if(typeof code!=='string' || !/^[0-9A-Z]{5}$/.test(code)) return;
  const fingerprint=statements.get(error);
  return {code,...(typeof detail==='string'?{detail}:{}),
    ...(fingerprint?{statement_fingerprint:fingerprint}:{})};
}
