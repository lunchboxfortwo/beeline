/**
 * Attachments a person shares in a Room arrive at the harness as content, never
 * as a URL the harness must fetch: a Codex session runs inside Codex's own OS
 * sandbox with `networkAccess: false`, so any curl/fetch it attempts is denied
 * and the agent reports "downloads were blocked". The daemon (outside that
 * sandbox) downloads each file into the session's own scratch directory — the
 * `TMPDIR` overlay `agent-home.ts` gives every session and `bwrap-sandbox.ts`
 * mounts writable — and names the LOCAL PATH in the prompt. Images additionally
 * ride along as ACP `image` blocks when the harness advertises
 * `promptCapabilities.image`. The capability URL stays as a trailing reference
 * for harnesses that keep network.
 *
 * An image that cannot ride inline is never silently reduced to a path (C87).
 * There are exactly two reasons it cannot — the harness does not advertise
 * `promptCapabilities.image`, or the file is past `MAX_INLINE_IMAGE_BYTES` —
 * and both are named in the prompt so the agent says so in one plain sentence
 * in the SAME turn instead of inventing a description or waiting on a picture
 * that is not coming.
 */
import type { DaemonAttachment } from '@beeline/api-contract/daemon';
import { mkdir,writeFile } from 'node:fs/promises';
import { basename,extname,join } from 'node:path';

/** Same ceiling as the artifact path (`read-only-mcp.ts`). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/**
 * Person-uploaded attachment bytes live 24 hours on the server; agent artifact
 * bytes live seven days (`apps/server/src/media-ttl.ts`). Past the applicable
 * window the file is gone, not missing: the server marks the attachment
 * `expired` and answers its media URL with 410 Gone. Either fact is reported in
 * those words, so an agent asked about an old file says it expired instead of
 * "not found", which reads like a bug it should retry.
 */
export const EXPIRED_REASON = 'expired: these attachment bytes are past their retention window';
/** One download may not wedge a turn; a slow media read degrades to the URL line. */
export const FETCH_TIMEOUT_MS = 30_000;

/** A Content-Length or body past `MAX_ATTACHMENT_BYTES`. */
export class BoundedSizeError extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super(`${bytes} bytes exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit`);
    this.name = 'BoundedSizeError';
    this.bytes = bytes;
  }
}

export interface BoundedFetchResult {
  readonly status: number;
  readonly ok: boolean;
  readonly bytes: Buffer;
  readonly mimeType: string;
}

/**
 * The one daemon-side download: 30 s timeout, 25 MB ceiling. A 410 or other
 * non-OK status returns without reading the body so callers can name expiry
 * separately from a failed fetch. Size is refused from Content-Length before
 * the body is read. The stream is cancelled as soon as its byte count exceeds
 * the same ceiling, even when Content-Length is missing or understated.
 */
export async function fetchBoundedBytes(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BoundedFetchResult> {
  const response = await fetchImpl(url, {
    signal: undefined,
  });
  if (response.status === 410 || !response.ok) {
    await response.body?.cancel();
    return { status: response.status, ok: response.ok, bytes: Buffer.alloc(0), mimeType: '' };
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_ATTACHMENT_BYTES) {
    await response.body?.cancel();
    throw new BoundedSizeError(declared);
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ATTACHMENT_BYTES) {
          await reader.cancel();
          throw new BoundedSizeError(size);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = Buffer.concat(chunks, size);
  const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  return { status: response.status, ok: true, bytes, mimeType };
}

/**
 * The ceiling on ONE inline image. An inline block is base64 on a single
 * JSON-RPC line to the harness AND stays in that session's conversation
 * history, re-sent upstream on every later turn, so the 25 MB store ceiling is
 * the wrong bound here: a phone photo fits under this one, a raw scan does
 * not. Past it the file is still downloaded and named — only the inline copy
 * is refused, with a reason.
 */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

export interface DeliveredAttachment {
  readonly attachment: DaemonAttachment;
  /** Local copy the harness can read; absent when the download was skipped or failed. */
  readonly path?: string;
  /** Why there is no local copy. */
  readonly reason?: string;
  /** Inline image payload for a multimodal harness; only for `image/*` local copies. */
  readonly image?: { data: string; mimeType: string };
  /**
   * Set when the local copy IS an image but deliberately does not ride inline
   * — a fact about the file, so it survives `withoutImageData` and reads the
   * same on a later transcript render.
   */
  readonly inlineSkipped?: string;
}

/**
 * One sanitized, collision-free file name per attachment of a message, in
 * order. Path separators, leading dots and other unsafe characters never
 * survive, so a name joined under a directory stays inside it.
 */
export function safeAttachmentNames(attachments: readonly DaemonAttachment[]): string[] {
  const taken = new Set<string>();
  return attachments.map((attachment, index) => safeFileName(attachment, index, taken));
}

function safeFileName(attachment: DaemonAttachment, index: number, taken: Set<string>): string {
  const raw = basename(attachment.name ?? '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^\.+/, '');
  let name = raw || `attachment-${index + 1}`;
  if (taken.has(name)) {
    const ext = extname(name);
    name = `${name.slice(0, name.length - ext.length)}-${index + 1}${ext}`;
  }
  taken.add(name);
  return name;
}

/**
 * Download every attachment of one message into `dir`. Never throws: a skipped
 * or failed download degrades to a reason for that file. Successful cached
 * copies are reused; failed downloads return their first failure.
 */
export async function deliverAttachments(
  attachments: readonly DaemonAttachment[],
  dir: string,
  fetchImpl: typeof fetch = fetch,
  cached: readonly DeliveredAttachment[] = [],
): Promise<DeliveredAttachment[]> {
  if (!attachments.length) return [];
  const names = safeAttachmentNames(attachments);
  return Promise.all(
    attachments.map(async (attachment, index): Promise<DeliveredAttachment> => {
      const tooLarge = (bytes: number) => ({
        attachment,
        reason: `skipped: ${bytes} bytes exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit`,
      });
      if (attachment.size && attachment.size > MAX_ATTACHMENT_BYTES)
        return tooLarge(attachment.size);
      if (attachment.expired) return { attachment, reason: EXPIRED_REASON };
      const previous = cached.find((entry) => entry.path && entry.attachment.url === attachment.url);
      if (previous) return previous;
      try {
        await mkdir(dir, { recursive: true });
        const fetched = await fetchBoundedBytes(attachment.url, fetchImpl);
        // 410 Gone is the server's explicit media expiry outcome.
        if (fetched.status === 410) return { attachment, reason: EXPIRED_REASON };
        if (!fetched.ok) throw new Error(`HTTP ${fetched.status}`);
        const path = join(dir, names[index]!);
        await writeFile(path, fetched.bytes);
        const bytes = fetched.bytes;
        const mimeType = attachment.mimeType ?? fetched.mimeType;
        if (!mimeType.startsWith('image/')) return { attachment, path };
        if (bytes.length > MAX_INLINE_IMAGE_BYTES) {
          return {
            attachment,
            path,
            inlineSkipped: `${bytes.length} bytes is past the ${MAX_INLINE_IMAGE_BYTES}-byte inline image limit`,
          };
        }
        return { attachment, path, image: { data: bytes.toString('base64'), mimeType } };
      } catch (error) {
        if (error instanceof BoundedSizeError) return tooLarge(error.bytes);
        return {
          attachment,
          reason: `download failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }),
  );
}

const MEDIA_ID =
  /\/v1\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[?#]|$)/i;

/**
 * The stable id `download_attachment` takes: the server media id the
 * attachment URL names. Undefined for a URL that names no server media.
 */
export function attachmentId(attachment: Pick<DaemonAttachment, 'url'>): string | undefined {
  return MEDIA_ID.exec(attachment.url)?.[1]?.toLowerCase();
}

function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One marker line per attachment of a transcript message: name, type, size
 * and the id `download_attachment` takes. Building it downloads nothing; an
 * older message is re-rendered every turn, so its files are fetched only when
 * the agent asks for one.
 */
export function attachmentMarkerLines(attachments: readonly DaemonAttachment[]): string[] {
  return attachments.map((attachment) => {
    const metadata = [attachment.mimeType, attachment.size ? readableSize(attachment.size) : '']
      .filter(Boolean)
      .join(', ');
    const id = attachmentId(attachment);
    return `📎 ${attachment.name ?? 'attachment'}${metadata ? ` (${metadata})` : ''} ${
      id ? `id=${id}` : 'id unavailable'
    }${attachment.expired ? ' (expired)' : ''}`;
  });
}

/** Drop the inline image bytes once the prompt is built, so a transcript cache stays small. */
export function withoutImageData(delivered: readonly DeliveredAttachment[]): DeliveredAttachment[] {
  return delivered.map(({ image: _image, ...rest }) => rest);
}
