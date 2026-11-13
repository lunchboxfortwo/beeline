import { CommandRefusalError } from '../command-refusal.js';
import type { PhoneContext } from './context.js';
import type { Input } from './types.js';
import { phoneCreateInvite } from './members-invites.js';
import { phoneHasRoomAccess, phoneRequireIdentity } from './access.js';

/**
 * Invite by email (Members → People + → Invite by email). Same authority as
 * `createInvite`, which mints the link; the server then sends one plain email
 * through Resend's HTTP API. No retries and no timers: a failed send is the
 * caller's answer.
 *
 * Environment:
 * - `BEELINE_EMAIL_API_KEY` (required): without it the operation refuses.
 * - `BEELINE_EMAIL_FROM` (optional): the sender, default `Beeline <invites@usebeeline.app>`.
 * - `BEELINE_INVITE_ORIGIN` (optional): the app-link origin invite links open,
 *   default `https://usebeeline.app` (the phone's own invite-link origin).
 */
export const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
export const DEFAULT_BEELINE_EMAIL_FROM = 'Beeline <invites@usebeeline.app>';
export const DEFAULT_INVITE_ORIGIN = 'https://usebeeline.app';
export const EMAIL_INVITE_UNAVAILABLE = 'Invite by email is not set up on this server.';

type Env = Readonly<Record<string, string | undefined>>;

export async function phoneInviteByEmail(
  ctx: PhoneContext,
  input: Input<'inviteByEmail'>,
  viewerId: string,
  env: Env = process.env,
  send: typeof fetch = fetch,
): Promise<void> {
  const key = env.BEELINE_EMAIL_API_KEY?.trim();
  if (!key) throw new CommandRefusalError(EMAIL_INVITE_UNAVAILABLE, 409);
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  if (!email) throw new Error('email is required');

  const invite = await phoneCreateInvite(ctx, { workspaceId: input.workspaceId }, viewerId);
  const workspace = (await ctx.database.query<{ name: string }>(
    `SELECT name FROM workspaces WHERE id=$1`, [input.workspaceId],
  )).rows[0]?.name ?? 'Beeline';
  // The chat is only named when the inviter can see it.
  const room = input.roomId && (await phoneHasRoomAccess(ctx, input.roomId, viewerId))
    ? (await ctx.database.query<{ name: string }>(
        `SELECT name FROM rooms WHERE id=$1 AND workspace_id=$2`, [input.roomId, input.workspaceId],
      )).rows[0]?.name
    : undefined;
  const inviter = await phoneRequireIdentity(ctx, viewerId);
  const origin = new URL(env.BEELINE_INVITE_ORIGIN?.trim() || DEFAULT_INVITE_ORIGIN).origin;
  const link = `${origin}/join/${encodeURIComponent(invite.token)}`;
  const from = env.BEELINE_EMAIL_FROM?.trim() || DEFAULT_BEELINE_EMAIL_FROM;
  const message = inviteEmail({ inviter: inviter.handle ? `@${inviter.handle}` : inviter.name, workspace, room, link });

  const response = await send(RESEND_EMAILS_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [email], subject: message.subject, text: message.text }),
  });
  if (response.ok) return;
  // Resend names a bad address itself (400/422); that is the person's answer.
  // Anything else (key, domain, quota, outage) is this server's failure.
  if (response.status === 400 || response.status === 422) {
    const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
    throw new CommandRefusalError(typeof body?.message === 'string' ? body.message : 'invalid email address', 400);
  }
  throw new Error(`Resend did not send the invite email (${response.status})`);
}

/** One plain email: who invited you, where to, and the link. */
export function inviteEmail({ inviter, workspace, room, link }: {
  inviter: string; workspace: string; room?: string; link: string;
}): { subject: string; text: string } {
  const where = room ? `${workspace} and #${room}` : workspace;
  return {
    subject: `${inviter} invited you to ${workspace} on Beeline`,
    text: `${inviter} invited you to join ${where} on Beeline.\n\nOpen this link to join:\n${link}\n`,
  };
}
