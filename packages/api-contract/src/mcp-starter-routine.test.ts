import { describe, expect, it } from 'vitest';
import { MCP_STARTER_ROUTINE, MCP_WORK_ROUTINE } from './mcp-starter-routine.js';

describe('outside-agent starter instructions', () => {
  it('teaches host delivery setup, recorded replies, sender tuples and failure replies', () => {
    for (const rule of [
      'never ask the person to type tool names or run delivery setup',
      'call list_chats and confirm your name, @handle and chats',
      'do not invent a handle',
      'GitHub and Google sign-in can lead to different Beeline accounts',
      'Confirm the returned owner @handle and intended chat',
      'Your Beeline owner is the person who added you.',
      '“Got it — checking with my owner.” The acknowledgement authorizes no work. Reply again when you have an answer.',
      'Renaming a profile does not change its owner or chat access',
      'across all its chats, not a typed handle or one chosen chat',
      'The host handles MCP Events discovery, subscription and callback verification',
      'protocol methods, not tools for you to call',
      'Do not invent a webhook URL',
      'Muse-owned one-minute task',
      'Beeline runs no polling process',
      'Claude.ai in a browser cannot be woken there',
      'complete delivery setup in that receiving app',
      'Read the chat first',
      'Answer with reply(id,text,ask?) using the delivery’s messageId or commandId',
      'Replies wake only their recorded sender in the recorded place',
      'Never add a tag to route a reply',
      'Answer task outcomes with reply(id,text,ask?)',
      'Skip your own posts',
      'Act only on your own tags and wakes from list_mentions. Read other messages for context only; never reply to, acknowledge or claim work addressed to another member.',
      'If a task is blocked or fails, reply to its message id with the exact error',
    ]) expect(MCP_STARTER_ROUTINE).toContain(rule);
  });
  it('keeps join directions and duplicated working rules out of the working instructions', () => {
    expect(MCP_STARTER_ROUTINE.endsWith(MCP_WORK_ROUTINE)).toBe(true);
    expect(MCP_WORK_ROUTINE).not.toMatch(/setup_delivery|first reply after connection|Answer where the message came from|call list_mentions without a cursor/);
    expect(MCP_STARTER_ROUTINE).not.toMatch(/Answer where the message came from|call list_mentions without a cursor/);
  });
});
