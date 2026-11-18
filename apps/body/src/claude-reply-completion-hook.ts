#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** A successful delivery is terminal only when the server confirms the whole turn. */
export function replyCompletesTurn(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const hook = input as Record<string, unknown>;
  if (hook.hook_event_name !== 'PostToolUse' || hook.tool_name !== 'mcp__beeline-agent__reply') return false;
  let response = hook.tool_response;
  if (typeof response === 'string') {
    try { response = JSON.parse(response); } catch { return false; }
  }
  if (!response || typeof response !== 'object') return false;
  if (Array.isArray(response)) response = {content:response};
  const result = response as { isError?: boolean; _meta?: { beeline?: { turnComplete?: boolean } }; content?: {type?:string;text?:string}[] };
  if (result.isError) return false;
  if (result._meta?.beeline?.turnComplete === true) return true;
  return Array.isArray(result.content) && result.content.some(block => {
    if (block.type !== 'text' || typeof block.text !== 'string') return false;
    try {
      const value = JSON.parse(block.text);
      return value?._meta?.beeline?.turnComplete === true;
    } catch { return false; }
  });
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  let source = '';
  for await (const chunk of process.stdin) source += chunk;
  let complete = false;
  try { complete = replyCompletesTurn(JSON.parse(source)); } catch { /* Missing proof keeps the turn open. */ }
  process.stdout.write(JSON.stringify(complete ? {continue:false,suppressOutput:true} : {continue:true}));
}
