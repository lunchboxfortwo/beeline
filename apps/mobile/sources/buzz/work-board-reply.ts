import type { RoomViewIdentity, WorkItemView } from '@beeline/api-contract/phone';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { MonolithRigTransport } from '@/sync/transport/monolith-rig-transport';
import { startMessageOutbox } from './message-outbox-runtime';
import { getMessageOutbox } from './message-outbox-storage';
import { prefillText, textTagsAgent } from './composer-prefill';
import { getBuzzRuntimeConfig } from './runtime-config';

/** The ordinary composer outbox owns delivery and reconnect, including a board reply. */
export async function sendWorkReply(
  item: WorkItemView,
  text: string,
  author: RoomViewIdentity,
): Promise<boolean> {
  if (!item.messageId || !text.trim()) return false;
  const identity = await loadBuzzIdentity();
  if (!identity || identity.publicKey !== author.pubkey) return false;
  await startMessageOutbox();
  const reply = { channelId: item.roomId, eventId: item.messageId, rootId: item.messageId };
  const asker = item.ask?.author;
  const addressed =
    asker?.kind === 'agent' && asker.handle && !textTagsAgent(text, asker.handle, asker.pubkey)
      ? prefillText(asker.handle) + text
      : text;
  const event = await new MonolithRigTransport(identity).composeReplyMessage(addressed, reply);
  const outbox = getMessageOutbox(getBuzzRuntimeConfig().monolithUrl, identity);
  await outbox.enqueue(event, {
    id: event.id,
    text: addressed,
    createdAt: event.created_at,
    author,
    presentation: 'message',
    reply,
  });
  void outbox.send(event.id);
  return true;
}
