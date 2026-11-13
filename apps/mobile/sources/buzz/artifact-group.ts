import type { AttachmentReference } from '@beeline/buzz-client';

import { artifactFormat, formatAttachmentSize } from '@/buzz/artifact';

/** The stacked card folds its file list after this many rows. */
export const ARTIFACT_GROUP_VISIBLE_ROWS = 3;

/**
 * The files of one message that share one stacked card: every live file, in
 * message order — the file itself decides, not an optional server decoration.
 * Expired files keep their own expired line, and a message with one live file
 * keeps the single card, so both return undefined. `skip` drops attachments
 * the message already shows another way.
 */
export function messageArtifactGroup(
  attachments: readonly AttachmentReference[] | undefined,
  skip?: (attachment: AttachmentReference, index: number) => boolean,
): readonly AttachmentReference[] | undefined {
  const live = (attachments ?? []).filter((attachment, index) =>
    !attachment.expired && !skip?.(attachment, index));
  return live.length > 1 ? live : undefined;
}

/** “PNG”, “PDF”, “HTML”, “Interactive”, or a whole document type (“TEXT/CSV”). */
export function artifactKindWord(mimeType: string, format: ReturnType<typeof artifactFormat>): string {
  if (format === 'game') return 'Interactive';
  const mime = mimeType.toLowerCase().split(';')[0]!.trim();
  if (format === 'document') return mime.toUpperCase();
  const subtype = mime.split('/')[1]?.split('+')[0] ?? format;
  return (subtype === 'plain' ? 'text' : subtype).toUpperCase();
}

/** “PNG · 57 KB”: the file's kind word and size. */
export function fileKindLine(attachment: AttachmentReference): string {
  return `${artifactKindWord(attachment.mimeType, artifactFormat(attachment.mimeType))} · ${formatAttachmentSize(attachment.size)}`;
}

/** “@ruby · PNG · 57 KB”: the author, then the kind line. */
export function authorKindLine(attachment: AttachmentReference, authorHandle: string | undefined): string {
  const handle = attachment.author ?? authorHandle;
  return `${handle ? `@${handle.replace(/^@/, '')} · ` : ''}${fileKindLine(attachment)}`;
}
