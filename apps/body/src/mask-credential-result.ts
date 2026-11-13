import { isCredentialFetchToolName } from '@beeline/api-contract/daemon';
import type { ToolCallEntry } from './acp.js';

/** Tool identity, including MCP names and harness argument envelopes; never output text. */
function matchesTool(call: ToolCallEntry, matches: (value: unknown) => boolean): boolean {
  if (matches(call.name) || matches(call.title)) return true;
  let input = call.rawInput;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch { return false; }
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const record = input as Record<string, unknown>;
    if (matches(record.name) || matches(record.tool) || matches(record.tool_name)) return true;
    input = record.arguments ?? record.tool_input ?? record.toolInput;
  }
  return false;
}

/** The harness receives real credentials. Body records mask fetched results and stored inputs. */
export function maskCredentialResult<T extends ToolCallEntry>(call: T, identity: ToolCallEntry = call): T {
  const storesSecret = matchesTool(identity, value =>
    typeof value === 'string' && /(?:^|[._:/-])store_secret$/.test(value));
  if (!storesSecret && !matchesTool(identity, isCredentialFetchToolName)) return call;
  return {
    ...call,
    ...(storesSecret ? { name: 'store_secret', title: 'store_secret', rawInput: '[REDACTED]' } : {}),
    ...('content' in call ? { content: '[REDACTED]' } : {}),
    ...('rawOutput' in call ? { rawOutput: '[REDACTED]' } : {}),
    ...('locations' in call ? { locations: undefined } : {}),
    ...(call.rawOutput && typeof call.rawOutput === 'object' &&
      (call.rawOutput as { isError?: unknown }).isError === true ? { status: 'failed' } : {}),
  };
}
