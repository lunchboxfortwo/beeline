import { expect, it, vi } from 'vitest';
import { CLAUDE_OAUTH, CLAUDE_SIGN_IN_REJECTED_MESSAGE, ClaudeSignIn } from './claude-sign-in.js';

function attempt(fetch: typeof globalThis.fetch) {
  const signIn = new ClaudeSignIn({ fetch, now: () => 1_000 });
  const state = new URL(signIn.start('attempt')).searchParams.get('state')!;
  return { signIn, pasted: `pasted-code#${state}` };
}

it("exchanges the pasted code once with Claude's sign-in service", async () => {
  const fetch = vi.fn(async () =>
    Response.json({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3600,
      scope: 'user:inference',
    }),
  );
  const { signIn, pasted } = attempt(fetch as typeof globalThis.fetch);
  await expect(signIn.complete('attempt', pasted)).resolves.toMatchObject({
    access_token: 'access',
    refresh_token: 'refresh',
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]).toEqual([
    CLAUDE_OAUTH.tokenUrl,
    expect.objectContaining({ method: 'POST' }),
  ]);
});

it('keeps the attempt after a rejected code and names an unreachable service', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response('{}', { status: 400 }))
    .mockRejectedValueOnce(new TypeError('fetch failed'));
  const { signIn, pasted } = attempt(fetch);
  await expect(signIn.complete('attempt', pasted)).rejects.toThrow(CLAUDE_SIGN_IN_REJECTED_MESSAGE);
  await expect(signIn.complete('attempt', pasted)).rejects.toThrow(
    "Could not reach Claude's sign-in service from the agent's machine. Try again.",
  );
});
