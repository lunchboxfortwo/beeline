import { describe, expect, it, vi } from 'vitest';
import { CommandRefusalError } from '../command-refusal.js';
import type { PhoneContext } from './context.js';
import {
  DEFAULT_BEELINE_EMAIL_FROM, EMAIL_INVITE_UNAVAILABLE, RESEND_EMAILS_URL, inviteEmail, phoneInviteByEmail,
} from './email-invite.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const VIEWER = 'a'.repeat(64);

/** Answers each statement the operation makes by its shape. */
function context({ manager = true, roomAccess = true } = {}) {
  const statements: string[] = [];
  type Fake = {
    query(sql: string): Promise<{ rows: unknown[]; rowCount: number }>;
    transaction<T>(run: (db: Fake) => Promise<T>): Promise<T>;
  };
  const database: Fake = {
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes('FOR UPDATE')) return { rows: [{ id: WORKSPACE }], rowCount: 1 };
      if (sql.includes("role IN ('owner','admin')")) return { rows: manager ? [{}] : [], rowCount: manager ? 1 : 0 };
      if (sql.includes('SELECT visibility FROM workspaces')) return { rows: [{ visibility: 'invite-only' }], rowCount: 1 };
      if (sql.includes('INSERT INTO invites')) return { rows: [], rowCount: 1 };
      if (sql.includes('SELECT name FROM workspaces')) return { rows: [{ name: 'Beeline Work' }], rowCount: 1 };
      if (sql.includes('JOIN memberships room_member')) return { rows: roomAccess ? [{}] : [], rowCount: roomAccess ? 1 : 0 };
      if (sql.includes('SELECT name FROM rooms')) return { rows: [{ name: 'beeline' }], rowCount: 1 };
      if (sql.includes('FROM identities')) return {
        rows: [{ id: VIEWER, kind: 'human', name: 'Dan', handle: 'lunchboxfortwo', avatar: null, face_id: null }], rowCount: 1,
      };
      throw new Error(`unexpected statement: ${sql}`);
    },
    async transaction<T>(run: (db: typeof database) => Promise<T>) { return run(database); },
  };
  return { ctx: { database, publicOrigin: 'https://server.usebeeline.app' } as unknown as PhoneContext, statements };
}

const ok = () => vi.fn(async () => new Response(JSON.stringify({ id: 'email-1' }), { status: 200 }));

describe('inviteByEmail', () => {
  it('refuses in plain words when BEELINE_EMAIL_API_KEY is unset, before minting anything', async () => {
    const { ctx, statements } = context();
    const send = ok();
    const refusal = await phoneInviteByEmail(ctx, { workspaceId: WORKSPACE, email: 'kai@example.com' }, VIEWER, {}, send)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(CommandRefusalError);
    expect((refusal as CommandRefusalError).message).toBe(EMAIL_INVITE_UNAVAILABLE);
    expect((refusal as CommandRefusalError).status).toBe(409);
    expect(send).not.toHaveBeenCalled();
    expect(statements).toEqual([]);
  });

  it('mints an invite with createInvite authority and sends one email through Resend', async () => {
    const { ctx, statements } = context();
    const send = ok();
    await phoneInviteByEmail(ctx, { workspaceId: WORKSPACE, roomId: ROOM, email: ' kai@example.com ' }, VIEWER,
      { BEELINE_EMAIL_API_KEY: 're_test' }, send);
    expect(statements.some((sql) => sql.includes('INSERT INTO invites'))).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RESEND_EMAILS_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer re_test');
    const body = JSON.parse(String(init.body));
    expect(body.from).toBe(DEFAULT_BEELINE_EMAIL_FROM);
    expect(body.to).toEqual(['kai@example.com']);
    expect(body.subject).toBe('@lunchboxfortwo invited you to Beeline Work on Beeline');
    expect(body.text).toContain('join Beeline Work and #beeline on Beeline');
    expect(body.text).toMatch(/https:\/\/usebeeline\.app\/join\/\S+/);
  });

  it('uses BEELINE_EMAIL_FROM and BEELINE_INVITE_ORIGIN when set, and omits a chat the inviter cannot see', async () => {
    const { ctx } = context({ roomAccess: false });
    const send = ok();
    await phoneInviteByEmail(ctx, { workspaceId: WORKSPACE, roomId: ROOM, email: 'kai@example.com' }, VIEWER,
      { BEELINE_EMAIL_API_KEY: 're_test', BEELINE_EMAIL_FROM: 'Team <team@example.com>', BEELINE_INVITE_ORIGIN: 'https://staging.example.com/x' }, send);
    const body = JSON.parse(String((send.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.from).toBe('Team <team@example.com>');
    expect(body.text).toContain('join Beeline Work on Beeline');
    expect(body.text).toMatch(/https:\/\/staging\.example\.com\/join\/\S+/);
  });

  it('keeps createInvite authority: a non-manager is refused and nothing is sent', async () => {
    const { ctx } = context({ manager: false });
    const send = ok();
    await expect(phoneInviteByEmail(ctx, { workspaceId: WORKSPACE, email: 'kai@example.com' }, VIEWER,
      { BEELINE_EMAIL_API_KEY: 're_test' }, send)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("passes Resend's own refusal of an address back as a 400 and makes no second attempt", async () => {
    const { ctx } = context();
    const send = vi.fn(async () => new Response(JSON.stringify({ message: 'Invalid `to` field.' }), { status: 422 }));
    const refusal = await phoneInviteByEmail(ctx, { workspaceId: WORKSPACE, email: 'nope' }, VIEWER,
      { BEELINE_EMAIL_API_KEY: 're_test' }, send).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(CommandRefusalError);
    expect((refusal as CommandRefusalError).status).toBe(400);
    expect((refusal as Error).message).toBe('Invalid `to` field.');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('treats any other Resend failure as a server failure, once', async () => {
    const { ctx } = context();
    const send = vi.fn(async () => new Response('{}', { status: 500 }));
    const failure = await phoneInviteByEmail(ctx, { workspaceId: WORKSPACE, email: 'kai@example.com' }, VIEWER,
      { BEELINE_EMAIL_API_KEY: 're_test' }, send).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(CommandRefusalError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('writes one plain email naming the inviter, the place and the link', () => {
    expect(inviteEmail({ inviter: '@dan', workspace: 'Acme', link: 'https://usebeeline.app/join/t' })).toEqual({
      subject: '@dan invited you to Acme on Beeline',
      text: '@dan invited you to join Acme on Beeline.\n\nOpen this link to join:\nhttps://usebeeline.app/join/t\n',
    });
  });
});
