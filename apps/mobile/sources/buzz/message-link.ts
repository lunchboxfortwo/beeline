import { messageJumpHref } from './corner-navigation';
import { messageLinkToken } from '@beeline/api-contract/phone';

/** The name is a readable label; only the global message id selects a target. */
export function messageLinkId(url: string): string | null {
  return /^#beeline\/[^\s/()<>]+\/([0-9a-f]{64})$/.exec(url)?.[1] ?? null;
}

let jumpSequence = 0;

export async function openMessageLink(url: string): Promise<void> {
  const messageId = messageLinkId(url);
  if (!messageId) return;
  const [{ loadBuzzIdentity, getEffectiveRelayUrl }, { RoomViewClient }, { router }] = await Promise.all([
    import('@/auth/buzz-identity-storage'),
    import('@/sync/transport/room-view-client'),
    import('expo-router'),
  ]);
  const identity = await loadBuzzIdentity();
  if (!identity) throw new Error('Message not available');
  const target = await new RoomViewClient({ identity, baseUrl: await getEffectiveRelayUrl() })
    .resolveMessageLink(messageId);
  router.navigate(messageJumpHref(target.roomId, target.messageId, `message-link:${++jumpSequence}`, target.workspaceId));
}

/**
 * The `¶author-N` token Copy link writes for one transcript row, or null when
 * the row has no server number yet (an unsent row, agent activity, a deleted
 * message) or no handle to name its author.
 */
export function chatMessageLinkToken(message: {
  readonly chatSeq?: number;
  readonly authorIdentity?: { readonly handle?: string };
  readonly isAgentActivity?: boolean;
  readonly isPendingSend?: boolean;
  readonly deleted?: boolean;
}): string | null {
  const handle = message.authorIdentity?.handle?.replace(/^@/, '');
  if (!handle || !message.chatSeq || message.isAgentActivity || message.isPendingSend || message.deleted) return null;
  return messageLinkToken(handle, message.chatSeq);
}

/** Copy a message link and say so; a refused clipboard says that instead. */
export async function copyChatMessageLink(
  token: string,
  write: (text: string) => Promise<unknown>,
  confirm: { showCopied(message: string): void; showCopyFailed(message: string): void },
): Promise<void> {
  try {
    await write(token);
    confirm.showCopied(`Copied ${token}`);
  } catch {
    confirm.showCopyFailed('Could not copy the link');
  }
}

/** Open a resolved `¶author-N` link: its chat or thread, scrolled to the message and highlighted. */
export function openChatMessageLink(
  link: { readonly roomId: string; readonly messageId: string; readonly workspaceId: string },
  navigate: (href: ReturnType<typeof messageJumpHref>) => void,
): void {
  navigate(messageJumpHref(link.roomId, link.messageId, `message-link:${++jumpSequence}`, link.workspaceId));
}
