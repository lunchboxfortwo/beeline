import { describe, expect, it } from 'vitest';
import { translateCursorStreamEvent } from './cursor-acp-bridge.js';

describe('translateCursorStreamEvent', () => {
  it('translates Cursor tool_call started/completed and tool_result frames into ACP updates', () => {
    expect(
      translateCursorStreamEvent({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'call-1',
        tool_call: {
          readToolCall: {
            args: { path: 'apps/body/src/room-turn-steps.ts' },
          },
        },
      }),
    ).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        name: 'read',
        title: 'read',
        kind: 'read',
        status: 'in_progress',
        rawInput: { path: 'apps/body/src/room-turn-steps.ts' },
      },
    ]);

    expect(
      translateCursorStreamEvent({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'call-1',
        tool_call: {
          readToolCall: {
            args: { path: 'apps/body/src/room-turn-steps.ts' },
            result: { success: { content: 'export const x = 1;' } },
          },
        },
      }),
    ).toEqual([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        name: 'read',
        title: 'read',
        kind: 'read',
        status: 'completed',
        rawInput: { path: 'apps/body/src/room-turn-steps.ts' },
        rawOutput: { content: 'export const x = 1;' },
      },
    ]);

    expect(
      translateCursorStreamEvent({
        type: 'tool_result',
        tool_call_id: 'call-2',
        is_error: true,
        error: 'Permission denied',
      }),
    ).toEqual([
      {
        sessionUpdate: 'tool_result',
        toolCallId: 'call-2',
        status: 'failed',
        rawOutput: 'Permission denied',
      },
    ]);
  });
});
