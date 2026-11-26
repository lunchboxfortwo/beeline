import type { ChatDisplayMessage } from './room-view-presentation';

/**
 * A corner a person opened FROM a message (the swipe-right forward) is one
 * durable `corner-open` card naming that message (`daemonFact.sourceMessageId`).
 * Move its row beneath the source message so it folds with neighbouring pills.
 *
 * A card whose source is not resident (older history not paged in, a deleted
 * row) stays on its own row, so the corner it opened is never unreachable.
 */
export function anchorCornerMarkers(messages: readonly ChatDisplayMessage[]): ChatDisplayMessage[] {
  const resident = new Map<string, string>();
  for (const message of messages) {
    // A marker never anchors another marker.
    if (message.daemonFact?.sourceMessageId) continue;
    resident.set(message.id, message.id);
    if (message.relayId) resident.set(message.relayId, message.id);
  }
  const markers = new Map<string, ChatDisplayMessage[]>();
  const anchored = new Set<string>();
  for (const message of messages) {
    if (
      message.daemonFact?.type &&
      message.daemonFact.type !== 'corner-open' &&
      message.daemonFact.type !== 'corner-complete' &&
      message.daemonFact.type !== 'backlog-added' &&
      message.systemEvent?.kind !== 'corner-opened'
    )
      continue;
    const source = message.daemonFact?.sourceMessageId;
    const anchor = source ? resident.get(source) : undefined;
    if (!anchor) continue;
    const marker: ChatDisplayMessage = {
      ...message,
      foldedReadBoundaries: [{
        id: message.id, orderAtMs: message.orderAtMs ?? message.timestamp * 1_000, anchored: true,
      }],
    };
    const siblings = markers.get(anchor);
    if (siblings) siblings.push(marker);
    else markers.set(anchor, [marker]);
    anchored.add(message.id);
  }
  if (!anchored.size) return [...messages];
  return messages.flatMap((message) => {
    if (anchored.has(message.id)) return [];
    const attached = markers.get(message.id);
    return attached ? [{ ...message, hasAnchoredCornerMarkers: true }, ...attached] : [message];
  });
}
