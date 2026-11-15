import { expect, it, vi } from 'vitest';
import { acpClientHandlePermission } from './acp-session-steer.js';
it('passes the last stated purpose to the native permission handler without command text', async () => {
  const permissionHandler = vi.fn(async (_request: unknown) => 'reject' as const);
  const ctx = { terminalSessions: new Set(), toolCallMetadata: new Map(), permissionNarration: new Map([['session', "I checked the files. I’ll verify the renewed domain."]]),
    autoApprove: false, permissionHandler, write: vi.fn(), emit: vi.fn() } as any;
  await acpClientHandlePermission(ctx, 1, { sessionId: 'session', toolCall: { title: 'Run check: node -e RAW_SCRIPT' } });
  expect(permissionHandler).toHaveBeenCalledWith(expect.objectContaining({ action: 'Run check', purpose: 'verify the renewed domain' }));
  ctx.permissionNarration.clear();
  await acpClientHandlePermission(ctx, 2, { sessionId: 'session', toolCall: { title: 'Run check: node -e RAW_SCRIPT' } });
  expect(permissionHandler.mock.calls[1]![0]).toMatchObject({ action: 'Run check', purpose: undefined });
});
