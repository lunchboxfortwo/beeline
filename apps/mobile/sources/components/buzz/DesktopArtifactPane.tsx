import { appReadErrorCopy } from '@/buzz/app-error-copy';
import { useArtifactRecoveryGeneration } from '@/buzz/use-artifact-recovery';
import React, { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { Copy as CopyIcon, ExternalLink, RefreshCw, Share2 } from 'lucide-react-native';
import type { AttachmentReference } from '@beeline/buzz-client';
import type { DesktopArtifactSelection } from '@/buzz/desktop-artifact-pane';

import { artifactFormat, wrapArtifactMarkup } from '@/buzz/artifact';
import {
  fetchArtifactBytes,
  fetchArtifactText,
  subscribeArtifactBytesPurge,
  openArtifactInBrowserOrExplain,
} from '@/buzz/artifact-link';
import { formatAttachmentSize } from '@/buzz/chat-attachment';
import { copyPicture, sharePicture } from '@/buzz/picture-actions';
import { ArtifactText } from '@/components/buzz/ArtifactMedia';
import { useCopiedToast } from '@/components/buzz/CopiedToast';
import { ZoomableArtifactImage } from '@/components/buzz/ZoomableArtifactImage';
import { ArtifactPdfView } from '@/components/buzz/ArtifactPdfView';
import { MonoMarkdown } from '@/components/buzz/MonoMarkdown';
import { ViewerConversationDock } from '@/components/buzz/ViewerConversationDock';
import { RunnableArtifact } from './RunnableArtifact';
import { DocumentFrame, TypedView } from '@/ui/grammar';
import {
  useFilePaging, ViewerAction, ViewerBody, ViewerHeader, ViewerNotice, ViewerPager, ViewerPlaceholder,
  ViewerPosition, ViewerScreen, ViewerScroll,
} from '@/ui/screens/viewers/ViewerChrome';

/**
 * The desktop work pane's artifact view (mock 1c, desktop): markup rendered in
 * a sandboxed iframe — `sandbox` carries neither `allow-scripts` nor
 * `allow-same-origin`, so the page cannot execute or reach storage, and the
 * bytes ride `srcdoc`, never a URL. Markdown, plain text and rasters render
 * through the app's own views. A PDF renders through the vendored pdf.js
 * document in its own frame, which is why that one is not the fully sandboxed
 * frame — see `buzz/artifact-pdf.ts` for what that trades and what it keeps.
 *
 * `Open in browser` stays on every format, not only the ones the pane cannot
 * paint: the signed link is the fallback when a render fails and the way out
 * for a reader who wants the file in a tab of their own.
 */
export function DesktopArtifactPane({
  attachment: selectedAttachment,
  groupAttachments,
  markdown,
  authorHandle,
  roomId,
  onClose,
}: {
  onClose(): void;
} & DesktopArtifactSelection) {
  // A stacked card hands over its whole message; the pane pages through it.
  const paging = useFilePaging(selectedAttachment, groupAttachments);
  const attachment = paging.file;
  const noun = groupAttachments?.every((file) => artifactFormat(file.mimeType) === 'image') ? 'photo' : 'file';
  const format = markdown ? 'markdown' : artifactFormat(attachment!.mimeType);
  const title = markdown?.title ?? attachment!.title ?? attachment!.name;
  const { showCopied, showCopyFailed, toast } = useCopiedToast('desktop-artifact-copied');
  const kindLine = `${authorHandle ? `@${authorHandle.replace(/^@/, '')} · ` : ''}${markdown ? `brief · revision ${markdown.revision}` : `${format === 'game' ? 'Interactive' : format} · ${formatAttachmentSize(attachment!.size)}`}`;
  const [runKey, setRunKey] = useState(0);
  return (
    <ViewerScreen testID="desktop-artifact-pane">
      <ViewerHeader
        title={format === 'game' ? `Interactive · ${title}` : title}
        detail={kindLine}
        titleTestID="desktop-artifact-title"
        detailTestID="desktop-artifact-kind-line"
        onClose={onClose}
        closeLabel="Close artifact pane"
        closeTestID="desktop-artifact-close"
      >
        {paging.paged ? <ViewerPosition index={paging.index} count={paging.count} noun={noun} /> : null}
        {attachment && format === 'game' ? (
          <ViewerAction label="Reopen" title="Reopen" icon={RefreshCw}
            onPress={() => setRunKey((key) => key + 1)} testID="desktop-artifact-reopen" />
        ) : null}
        {attachment && format === 'image' ? (
          <>
            <ViewerAction
              label="Copy image"
              title="Copy"
              icon={CopyIcon}
              onPress={() =>
                void copyPicture(attachment).then((copied) =>
                  copied ? showCopied('Image copied to clipboard') : showCopyFailed("Couldn't copy image"),
                )
              }
              testID="desktop-artifact-copy"
            />
            <ViewerAction label="Share image" title="Share" icon={Share2}
              onPress={() => void sharePicture(attachment)} testID="desktop-artifact-share" />
          </>
        ) : null}
        {attachment ? (
          <ViewerAction label="Open in browser" title="Open in browser" icon={ExternalLink}
            onPress={() => void openArtifactInBrowserOrExplain(attachment)} testID="desktop-artifact-open-browser" />
        ) : null}
      </ViewerHeader>
      <ViewerBody key={attachment?.url}>
        {markdown ? (
          <ViewerScroll testID="desktop-artifact-markdown">
            <TypedView view={MonoMarkdown} markdown={markdown.text} document />
          </ViewerScroll>
        ) : !attachment ? null : format === 'game' ? (
          <RunnableArtifact key={runKey} attachment={attachment} />
        ) : format === 'markdown' ? (
          <DesktopArtifactMarkdown attachment={attachment} />
        ) : format === 'html' || format === 'svg' ? (
          <DesktopArtifactFrame attachment={attachment} format={format} />
        ) : format === 'image' ? (
          <ZoomableArtifactImage
            attachment={attachment}
            title={title}
            testIDPrefix="desktop-artifact"
            {...(paging.paged ? { onSwipePhoto: paging.step } : {})}
          />
        ) : format === 'text' ? (
          <ArtifactText attachment={attachment} crop={false} testID="desktop-artifact-text" />
        ) : format === 'pdf' ? (
          <ArtifactPdfView attachment={attachment} mode="viewer" testID="desktop-artifact-pdf" />
        ) : (
          <ViewerNotice title="Preview unavailable" message="Open the file to view it."
            onOpenInBrowser={() => void openArtifactInBrowserOrExplain(attachment)} testID="desktop-artifact-handoff" />
        )}
      </ViewerBody>
      {paging.paged ? (
        <ViewerPager index={paging.index} count={paging.count} noun={noun}
          onPrevious={() => paging.step(-1)} onNext={() => paging.step(1)} />
      ) : null}
      {attachment && <ViewerConversationDock kind="artifact" title={attachment.name} roomId={roomId} agentHandle={authorHandle}
        artifact={attachment} />}
      {toast}
    </ViewerScreen>
  );
}

/** HTML/SVG: fetched bytes, CSP meta first, rendered from srcdoc with no script origin. */
export function DesktopArtifactFrame({
  attachment,
  format,
}: {
  attachment: AttachmentReference;
  format: 'html' | 'svg';
}) {
  const recovery = useArtifactRecoveryGeneration();
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const stopPurge = subscribeArtifactBytesPurge(attachment, () => { controller.abort(); setHtml(null); setFailed(true); });
    setHtml(null); setFailed(false);
    void fetchArtifactBytes(attachment, { signal: controller.signal })
      .then((bytes) => {
        if (live && !controller.signal.aborted) setHtml(wrapArtifactMarkup(new TextDecoder().decode(bytes), format));
      })
      .catch((cause) => {
        if (live && !controller.signal.aborted) setFailed(Boolean(appReadErrorCopy(cause)));
      });
    return () => {
      live = false; controller.abort(); stopPurge();
    };
  }, [attachment, format, recovery]);
  if (failed) return <ViewerNotice title="Page unavailable" testID="desktop-artifact-failed" />;
  if (html == null) return <ViewerPlaceholder text="Loading…" testID="desktop-artifact-loading" />;
  if (Platform.OS === 'web') {
    return <DocumentFrame srcDoc={html} sandbox="" title={attachment.name} testID="desktop-artifact-frame" paper />;
  }
  return <ViewerPlaceholder text="Loading…" testID="desktop-artifact-loading" />;
}

function DesktopArtifactMarkdown({ attachment }: { attachment: AttachmentReference }) {
  const recovery = useArtifactRecoveryGeneration();
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const stopPurge = subscribeArtifactBytesPurge(attachment, () => { controller.abort(); setMarkdown(null); setFailed(true); });
    setMarkdown(null); setFailed(false);
    void fetchArtifactText(attachment, { signal: controller.signal })
      .then((text) => {
        if (live && !controller.signal.aborted) setMarkdown(text);
      })
      .catch((cause) => {
        if (live && !controller.signal.aborted) setFailed(Boolean(appReadErrorCopy(cause)));
      });
    return () => {
      live = false; controller.abort(); stopPurge();
    };
  }, [attachment, recovery]);
  if (failed) return <ViewerNotice title="Page unavailable" testID="desktop-artifact-failed" />;
  if (markdown == null) return <ViewerPlaceholder text="Loading…" testID="desktop-artifact-loading" />;
  return (
    <ViewerScroll testID="desktop-artifact-markdown">
      <TypedView view={MonoMarkdown} markdown={markdown} document />
    </ViewerScroll>
  );
}
