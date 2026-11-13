import type { ChatDisplayMessage } from './room-view-presentation';

/**
 * An agent's order into, or report from, a corner reads as ordinary transcript.
 * The recipient becomes the first word as a plain @mention; the byline still
 * names the agent that wrote it, and every other message action stays available.
 * The record card that used to wrap these rows is gone.
 */
export function agentCommandTranscriptMessage(
  message: ChatDisplayMessage,
  participants: readonly { pubkey: string; handle: string }[],
): ChatDisplayMessage {
  const command = message.agentCommand;
  if (!command) return message;
  const participant = participants.find((candidate) => candidate.pubkey === command.recipient.id);
  const handle = (
    participant?.handle ??
    command.recipient.handle ??
    command.recipient.name
  ).replace(/^@/, '');
  // Keep agentCommand on the row: the text is display-only, but Reply needs
  // the marker to give this card row the same-Room parent proof it lacks.
  return {
    ...message,
    text: `@${handle} ${command.text}`,
  };
}

