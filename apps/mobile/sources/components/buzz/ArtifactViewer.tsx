import { appReadErrorCopy } from '@/buzz/app-error-copy';
import { useArtifactRecoveryGeneration } from '@/buzz/use-artifact-recovery';
import React, { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Copy as CopyIcon, RefreshCw, Share2 } from 'lucide-react-native';
import type { AttachmentReference } from '@beeline/buzz-client';

import { artifactFormat, createInitialLoadGuard, wrapArtifactMarkup } from '@/buzz/artifact';
import { artifactPdfLocalUri, fetchArtifactBytes, fetchArtifactText, openArtifactInBrowserOrExplain, subscribeArtifactBytesPurge } from '@/buzz/artifact-link';
import { artifactWebViewProps } from '@/components/buzz/artifact-webview';
import { useSandboxWebView, useSandboxWebViewStatus } from '@/components/buzz/sandbox-webview';
import { ArtifactText } from '@/components/buzz/ArtifactMedia';
import { ZoomableArtifactImage } from '@/components/buzz/ZoomableArtifactImage';
import { ArtifactPdfView } from '@/components/buzz/ArtifactPdfView';
import { MonoMarkdown } from '@/components/buzz/MonoMarkdown';
import { CodeHighlighter } from '@/components/buzz/CodeHighlighter';
import type { CodeDocument } from '@/buzz/code-document';
import * as Clipboard from 'expo-clipboard';
import { copyPicture, sharePicture } from '@/buzz/picture-actions';
import { useCopiedToast } from '@/components/buzz/CopiedToast';
import { ViewerConversationDock } from '@/components/buzz/ViewerConversationDock';
import { RunnableArtifact } from './RunnableArtifact';
import {
  PhotoStepper, ViewerAction, ViewerBody, ViewerHeader, ViewerInscription, ViewerNotice, ViewerPlaceholder,
  ViewerScreen, ViewerScroll,
} from '@/ui/screens/viewers/ViewerChrome';

/**
 * The full-screen artifact viewer (mock 1c): the whole page, still guarded —
 * exactly one navigation passes the gate, everything after it is refused, and
 * nothing here ever receives an onMessage bridge. Markdown renders through the
 * app's own renderer and plain text through the mono reader; an image fits the
 * screen; a PDF rides a local cache file on iOS and the fitted pdf.js document
 * on Android. Script stays off for everything except that document, which is
 * the renderer itself rather than anything an artifact's author wrote. A
 * document the app composes itself (the corner brief) arrives as `markdown`
 * text and reads through the same Markdown renderer as a Markdown artifact.
 */
export function ArtifactViewerScreen({
  attachment: initialAttachment,
  photoAttachments,
  document,
  markdown,
  notice,
  authorHandle,
  roomId,
  onClose,
}: (
  | { attachment: AttachmentReference; document?: never; markdown?: never; notice?: never }
  | { attachment?: never; document: CodeDocument; markdown?: never; notice?: never }
  | { attachment?: never; document?: never; markdown: { title: string; text: string }; notice?: never }
  | { attachment?: never; document?: never; markdown?: never; notice: { title: string; message: string } }
) & {
  authorHandle?: string;
  roomId?: string;
  photoAttachments?: readonly AttachmentReference[];
  onClose: () => void;
}) {
  const photos = initialAttachment && artifactFormat(initialAttachment.mimeType) === 'image'
    ? photoAttachments
    : undefined;
  const [photoIndex, setPhotoIndex] = useState(() =>
    Math.max(0, photos?.findIndex((photo) => photo.url === initialAttachment?.url) ?? 0),
  );
  const attachment = photos?.[photoIndex] ?? initialAttachment;
  const isPhotoGroup = Boolean(photos && photos.length > 1);
  const changePhoto = (direction: -1 | 1) => {
    if (isPhotoGroup) {
      setPhotoIndex((index) => (index + direction + photos!.length) % photos!.length);
    }
  };
  const format = attachment
    ? artifactFormat(attachment.mimeType)
    : document
      ? 'code'
      : markdown
        ? 'markdown'
        : 'notice';
  const title = initialAttachment
    ? (attachment!.title ?? attachment!.name)
    : document
      ? document.title
      : markdown
        ? markdown.title
        : notice.title;
  // The viewer fills the whole screen (HullModal placement 'fill', which is
  // translucent under both system bars on Android's mandatory edge-to-edge),
  // so the header clears the status tray the way every full-screen surface does.
  const { showCopied, showCopyFailed, toast } = useCopiedToast('artifact-viewer-copied');
  // Reopen restarts an interactive artifact from its first frame.
  const [runKey, setRunKey] = useState(0);
  return (
    <ViewerScreen testID="artifact-viewer">
      <ViewerHeader
        safeTop
        title={format === 'game' ? `Interactive · ${title}` : title}
        onClose={onClose}
        closeLabel="Close artifact viewer"
        closeTestID="artifact-viewer-close"
      >
        {format === 'game' ? (
          <ViewerAction label="Reopen" title="Reopen" icon={RefreshCw}
            onPress={() => setRunKey((key) => key + 1)} testID="artifact-viewer-reopen" />
        ) : format === 'code' && document ? (
          <ViewerAction
            label="Copy code"
            title="Copy"
            icon={CopyIcon}
            onPress={() =>
              void Clipboard.setStringAsync(document.code).then(
                (copied) =>
                  copied ? showCopied('Code copied to clipboard') : showCopyFailed("Couldn't copy code"),
                () => showCopyFailed("Couldn't copy code"),
              )
            }
            testID="artifact-viewer-copy"
          />
        ) : format === 'image' ? (
          <>
            <ViewerAction
              label="Copy image"
              title="Copy"
              icon={CopyIcon}
              onPress={() =>
                void copyPicture(attachment!).then((copied) =>
                  copied ? showCopied('Image copied to clipboard') : showCopyFailed("Couldn't copy image"),
                )
              }
              testID="artifact-viewer-copy"
            />
            <ViewerAction label="Share image" title="Share" icon={Share2}
              onPress={() => void sharePicture(attachment!)} testID="artifact-viewer-share" />
          </>
        ) : null}
      </ViewerHeader>
      <ViewerBody>
        {format === 'code' && document ? (
          <ViewerScroll testID="artifact-viewer-code">
            <ViewerInscription>{document.inscription}</ViewerInscription>
            <CodeHighlighter code={document.code} language={document.language} />
          </ViewerScroll>
        ) : format === 'notice' ? (
          <ViewerPlaceholder text={notice!.message} testID="artifact-viewer-notice" />
        ) : markdown ? (
          <ArtifactViewerMarkdownBody markdown={markdown.text} />
        ) : format === 'markdown' ? (
          <ArtifactViewerMarkdown attachment={attachment!} />
        ) : format === 'image' ? (
          <>
            {isPhotoGroup ? (
              <PhotoStepper index={photoIndex} count={photos!.length}
                onPrevious={() => changePhoto(-1)} onNext={() => changePhoto(1)} />
            ) : null}
            <ZoomableArtifactImage
              key={attachment!.url}
              attachment={attachment!}
              title={title}
              onSwipePhoto={isPhotoGroup ? changePhoto : undefined}
            />
          </>
        ) : format === 'text' ? (
          <ArtifactText attachment={attachment!} crop={false} testID="artifact-viewer-text" />
        ) : format === 'game' ? (
          <RunnableArtifact key={runKey} attachment={attachment!} />
        ) : format === 'pdf' && Platform.OS !== 'ios' ? (
          <ArtifactPdfView attachment={attachment!} mode="viewer" testID="artifact-viewer-pdf" />
        ) : (
          <ArtifactViewerSandbox
            attachment={attachment!}
            format={format as 'html' | 'svg' | 'pdf' | 'document'}
          />
        )}
      </ViewerBody>
      <ViewerConversationDock keyboardAvoidedByParent kind="artifact" title={attachment?.name ?? title} roomId={roomId} agentHandle={authorHandle}
        {...(attachment ? { artifact: attachment } : {})} />
      {toast}
    </ViewerScreen>
  );
}

/** HTML/SVG/PDF-iOS: the sandboxed render of the full page. */
export function ArtifactViewerSandbox({
  attachment,
  format,
}: {
  attachment: AttachmentReference;
  format: 'html' | 'svg' | 'pdf' | 'document';
}) {
  const recovery = useArtifactRecoveryGeneration();
  const [source, setSource] = useState<{ html: string } | { uri: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [unpreviewable, setUnpreviewable] = useState(false);
  const guardRef = useRef(createInitialLoadGuard());
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const stopPurge = subscribeArtifactBytesPurge(attachment, () => { controller.abort(); setSource(null); setFailed('This file is no longer available.'); });
    setSource(null); setFailed(null); setUnpreviewable(false);
    void (async () => {
      try {
        if (format === 'pdf') {
          const uri = await artifactPdfLocalUri(attachment, { signal: controller.signal });
          if (live && !controller.signal.aborted) { guardRef.current = createInitialLoadGuard(uri); setSource({ uri }); }
          return;
        }
        if (format === 'html' || format === 'svg') {
          const bytes = await fetchArtifactBytes(attachment, { signal: controller.signal });
          if (live && !controller.signal.aborted) {
            guardRef.current = createInitialLoadGuard();
            setSource({ html: wrapArtifactMarkup(new TextDecoder().decode(bytes), format) });
          }
          return;
        }
        if (live) setUnpreviewable(true);
      } catch (cause) {
        if (live && !controller.signal.aborted) setFailed(appReadErrorCopy(cause) || null);
      }
    })();
    return () => {
      live = false; controller.abort(); stopPurge();
    };
  }, [attachment, format, recovery]);
  const WebView = useSandboxWebView();
  const webviewStatus = useSandboxWebViewStatus();
  useEffect(() => {
    // The renderer never became available (the dynamic import failed): the
    // honest state is spoken, not an eternal "Loading…".
    if (source && !WebView && webviewStatus === 'unavailable') {
      setFailed('The in-app page renderer is unavailable — open it in a browser instead.');
    }
  }, [source, WebView, webviewStatus]);
  if (unpreviewable) {
    return (
      <ViewerNotice title="Preview unavailable" message="Open the file to view it."
        onOpenInBrowser={() => void openArtifactInBrowserOrExplain(attachment)} testID="artifact-viewer-failed" />
    );
  }
  if (failed) {
    return <ViewerNotice title="Page unavailable" message={failed} testID="artifact-viewer-failed" />;
  }
  if (source && WebView) {
    return (
      <WebView
        {...artifactWebViewProps({ source, guard: guardRef.current, scrollEnabled: true })}
        style={styles.webview}
        testID="artifact-viewer-webview"
      />
    );
  }
  return <ViewerPlaceholder text="Loading…" testID="artifact-viewer-loading" />;
}

function ArtifactViewerMarkdown({ attachment }: { attachment: AttachmentReference }) {
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
  if (failed) return <ViewerNotice title="Page unavailable" testID="artifact-viewer-failed" />;
  if (markdown == null) return <ViewerPlaceholder text="Loading…" testID="artifact-viewer-loading" />;
  return <ArtifactViewerMarkdownBody markdown={markdown} />;
}

function ArtifactViewerMarkdownBody({ markdown }: { markdown: string }) {
  return (
    <ViewerScroll testID="artifact-viewer-markdown">
      <MonoMarkdown markdown={markdown} textStyle={styles.markdownText} document />
    </ViewerScroll>
  );
}

const styles = StyleSheet.create((theme) => ({
  webview: { flex: 1, backgroundColor: 'transparent' },
  markdownText: { ...theme.buzz.type.body, color: theme.buzz.textPrimary },
}));
