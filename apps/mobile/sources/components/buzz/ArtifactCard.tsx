import { appReadErrorCopy } from '@/buzz/app-error-copy';
import { useArtifactRecoveryGeneration } from '@/buzz/use-artifact-recovery';
import { IndexRow } from './IndexRow';
import { ArtifactCardFrame, ArtifactFileRow } from '@/ui/screens/transcript/cards/ArtifactCardFrame';
import React, { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { Image, XStack, YStack } from 'tamagui';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { Glyph, T, TypedView } from '@/ui/grammar';
import type { AttachmentReference } from '@beeline/buzz-client';

import {
  ARTIFACT_MAX_PREVIEW_HEIGHT,
  artifactCapabilities,
  artifactFormat,
  mediaIdFromUrl,
} from '@/buzz/artifact';
import {
  ArtifactPreviewUnavailable,
  artifactImageSource,
  releaseArtifactImageSource,
  subscribeArtifactBytesPurge,
  fetchArtifactText,
} from '@/buzz/artifact-link';
import { ArtifactDocumentPreview } from './ArtifactDocumentPreview';
import { formatAttachmentSize } from '@/buzz/chat-attachment';
import { openArtifactInDesktopWorkPane } from '@/buzz/desktop-artifact-pane';
import { ArtifactImage, ArtifactText } from '@/components/buzz/ArtifactMedia';
import { ArtifactViewerScreen } from '@/components/buzz/ArtifactViewer';
import { currentViewerConversation } from '@/buzz/viewer-conversation';
import { MonoMarkdown } from '@/components/buzz/MonoMarkdown';
import { Modal } from '@/modal';

/** Reopen the same artifact surface from a card or transcript reference. */
export function openArtifactViewer(attachment: AttachmentReference, isDesktop = false,
  roomId = currentViewerConversation()?.roomId, authorHandle = attachment.author,
  photoAttachments?: readonly AttachmentReference[]) {
  const format = artifactFormat(attachment.mimeType);
  const objectId = mediaIdFromUrl(attachment.url);
  // A picture is not a document: every surface opens the same centered
  // full-screen viewer, so desktop reads an image the way mobile does. The
  // work pane keeps its documents — its sandboxed iframe is the right shape
  // for markup and PDFs, not for a raster.
  // When no second pane can take it (a narrow window, a direct message),
  // the document opens in the same full-screen viewer.
  if (
    isDesktop &&
    format !== 'image' &&
    openArtifactInDesktopWorkPane({
      attachment,
      authorHandle,
      roomId,
    })
  )
    return;
  Modal.show({
    component: ArtifactViewerScreen,
    props: {
      attachment,
      authorHandle,
      roomId,
      ...(photoAttachments && photoAttachments.length > 1 ? { photoAttachments } : {}),
    },
    // The viewer is a full-screen surface: the default centered placement
    // constrains width to 460 and no height, collapsing its flex:1 root to
    // nothing — a dimmed room with an invisible viewer.
    placement: 'fill',
  });
}

/**
 * Visible cards use an excerpt, thumbnail, or bounded sandbox render. Hidden
 * transcript rows retain the same frame without starting a byte request.
 */
export const ArtifactCard = React.memo(function ArtifactCard({
  attachment,
  authorHandle,
  isDesktop = false,
  photoAttachments,
  visible = true,
}: {
  visible?: boolean;
  attachment: AttachmentReference;
  authorHandle?: string;
  isDesktop?: boolean;
  /** Live image artifacts carried by the same message. Omitted for one photo. */
  photoAttachments?: readonly AttachmentReference[];
}) {
  const [photoIndex, setPhotoIndex] = useState(0);
  const isPhotoGroup = Boolean(photoAttachments && photoAttachments.length > 1);
  useEffect(() => {
    setPhotoIndex((index) => Math.min(index, Math.max(0, (photoAttachments?.length ?? 1) - 1)));
  }, [photoAttachments?.length]);
  const activeAttachment =
    (isPhotoGroup ? photoAttachments?.[photoIndex] : undefined) ?? attachment;
  const activeAuthorHandle = activeAttachment.author ?? authorHandle;
  const format = artifactFormat(activeAttachment.mimeType);
  const capabilities = artifactCapabilities(
    activeAttachment.mimeType,
    isDesktop ? 'desktop' : Platform.OS === 'ios' ? 'ios' : 'android',
  );
  const title = activeAttachment.title ?? activeAttachment.name;
  const kindWord = artifactKindWord(activeAttachment.mimeType, format);
  const kindLine = `${activeAuthorHandle ? `@${activeAuthorHandle.replace(/^@/, '')} · ` : ''}${kindWord} · ${formatAttachmentSize(activeAttachment.size)}`;
  const openFull = useCallback(() => {
    openArtifactViewer(activeAttachment, isDesktop, currentViewerConversation()?.roomId,
      activeAuthorHandle, isPhotoGroup ? photoAttachments : undefined);
  }, [activeAttachment, activeAuthorHandle, isDesktop, isPhotoGroup, photoAttachments]);

  // What is left external is what nothing on the device can paint — a ZIP, an
  // octet-stream, anything unrecognized. Those keep the file-style row and the
  // signed browser link, which is the only way to reach their contents.
  // What nothing on the device can paint (a ZIP, an octet-stream) is one row;
  // the viewer says “Preview unavailable” and offers Open in browser.
  if (capabilities.preview === 'external') {
    return (
      <ArtifactFileRow
        title={title}
        kindLine={kindLine}
        onOpen={openFull}
        testID={`artifact-document-${activeAttachment.name}`}
      />
    );
  }
  return (
    <ArtifactCardFrame
      title={title}
      kindLine={kindLine}
      onOpen={openFull}
      testID={isPhotoGroup ? 'artifact-photo-group' : `artifact-${format}-${activeAttachment.name}`}
      preview={<YStack
        minWidth={0}
        accessibilityLabel={`Open ${title} full screen`}
        accessibilityRole="button"
        onPress={openFull}
        testID={`artifact-preview-${activeAttachment.name}`}
      >
        {!visible ? (
          <PreviewLoading />
        ) : format === 'markdown' ? (
          <ArtifactMarkdownPreview attachment={activeAttachment} />
        ) : format === 'text' ? (
          <YStack height={ARTIFACT_MAX_PREVIEW_HEIGHT}>
            <ArtifactText attachment={activeAttachment} crop testID="artifact-preview-text" />
            <PreviewFade />
          </YStack>
        ) : format === 'image' ? (
          <YStack height={ARTIFACT_MAX_PREVIEW_HEIGHT}>
            <ArtifactImage
              attachment={activeAttachment}
              fit="cover"
              testID="artifact-preview-image"
            />
            {isPhotoGroup ? (
              <XStack pointerEvents="box-none" position="absolute" left={8} right={8} bottom={8} alignItems="center" justifyContent="space-between">
                <PhotoStep
                  accessibilityLabel="Previous photo"
                  accessibilityRole="button"
                  onPress={(event) => {
                    event?.stopPropagation();
                    setPhotoIndex((index) =>
                      index === 0 ? photoAttachments!.length - 1 : index - 1,
                    );
                  }}
                  testID="artifact-photo-previous"
                >
                  <Glyph icon={ChevronLeft} size={14} color="ink" />
                </PhotoStep>
                <T
                  v="code"
                  accessibilityLabel={`Photo ${photoIndex + 1} of ${photoAttachments!.length}`}
                  accessibilityLiveRegion="polite"
                  backgroundColor="canvas"
                  borderRadius="sm"
                  paddingHorizontal="2"
                  paddingVertical="1"
                  testID="artifact-photo-position"
                >
                  {photoIndex + 1} of {photoAttachments!.length}
                </T>
                <PhotoStep
                  accessibilityLabel="Next photo"
                  accessibilityRole="button"
                  onPress={(event) => {
                    event?.stopPropagation();
                    setPhotoIndex((index) => (index + 1) % photoAttachments!.length);
                  }}
                  testID="artifact-photo-next"
                >
                  <Glyph icon={ChevronRight} size={14} color="ink" />
                </PhotoStep>
              </XStack>
            ) : null}
          </YStack>
        ) : (
          <ArtifactSandboxPreview
            attachment={activeAttachment}
            format={format === 'pdf' ? 'pdf' : format === 'svg' ? 'svg' : 'html'}
          />
        )}
      </YStack>}
    />
  );
});

/** “PNG”, “PDF”, “HTML”, “Interactive”, or a whole document type (“TEXT/CSV”). */
export function artifactKindWord(mimeType: string, format: ReturnType<typeof artifactFormat>): string {
  if (format === 'game') return 'Interactive';
  const mime = mimeType.toLowerCase().split(';')[0]!.trim();
  if (format === 'document') return mime.toUpperCase();
  const subtype = mime.split('/')[1]?.split('+')[0] ?? format;
  return (subtype === 'plain' ? 'text' : subtype).toUpperCase();
}

type SandboxPreviewFormat = 'html' | 'svg' | 'pdf';

/**
 * Prefer an existing thumbnail; agent-posted documents without one render in
 * the same sandbox as Open, cropped to the card. Both share the byte cache.
 */
export function ArtifactSandboxPreview({
  attachment,
  format,
}: {
  attachment: AttachmentReference;
  format: SandboxPreviewFormat;
}) {
  const recovery = useArtifactRecoveryGeneration();
  const [source, setSource] = useState<Awaited<ReturnType<typeof artifactImageSource>> | null>(null);
  const [failed, setFailed] = useState(false);
  const [renderDocument, setRenderDocument] = useState(false);
  useEffect(() => {
    setFailed(false); setSource(null); setRenderDocument(false);
    let live = true; let loaded: Awaited<ReturnType<typeof artifactImageSource>> | null = null;
    const controller = new AbortController();
    const stopPurge = subscribeArtifactBytesPurge(attachment, () => { controller.abort(); releaseArtifactImageSource(loaded); setSource(null); setFailed(true); });
    // Missing thumbnails are expected for agent posts, not load failures.
    void artifactImageSource(attachment, { signal: controller.signal, preview: true, thumbnail: true }).then(value => {
      loaded = value; if (live && !controller.signal.aborted) setSource(value); else releaseArtifactImageSource(value);
    }).catch(error => {
      if (!live || controller.signal.aborted) return;
      if (error instanceof ArtifactPreviewUnavailable) setRenderDocument(true);
      else setFailed(Boolean(appReadErrorCopy(error)));
    });
    return () => { live = false; controller.abort(); stopPurge(); releaseArtifactImageSource(loaded); };
  }, [attachment, recovery]);
  if (failed) return (
    <PreviewFailed />
  );
  if (renderDocument) return <ArtifactDocumentPreview attachment={attachment} format={format} />;
  if (source) return <YStack height={ARTIFACT_MAX_PREVIEW_HEIGHT} testID="artifact-preview-snapshot"><Image source={source} resizeMode="cover" onError={() => setFailed(true)} width="100%" height="100%" /></YStack>;
  return <PreviewLoading />;
}

/** Markdown renders through the app's own message renderer, cropped to the card. */
export function ArtifactMarkdownPreview({ attachment }: { attachment: AttachmentReference }) {
  const recovery = useArtifactRecoveryGeneration();
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false); setMarkdown(null);
    let live = true;
    const controller = new AbortController();
    const stopPurge = subscribeArtifactBytesPurge(attachment, () => { controller.abort(); setMarkdown(null); setFailed(true); });
    void fetchArtifactText(attachment, { signal: controller.signal, preview: true })
      .then((text) => {
        if (live && !controller.signal.aborted) setMarkdown(text);
      })
      .catch((cause) => { if (live && !controller.signal.aborted) setFailed(Boolean(appReadErrorCopy(cause))); });
    return () => {
      live = false; controller.abort(); stopPurge();
    };
  }, [attachment, recovery]);
  if (failed) return (
    <PreviewFailed />
  );
  if (markdown == null) return <PreviewLoading />;
  return (
    <YStack
      pointerEvents="none"
      height={ARTIFACT_MAX_PREVIEW_HEIGHT}
      overflow="hidden"
      padding="2"
      testID="artifact-preview-markdown"
    >
      <TypedView view={MonoMarkdown} v="body" markdown={markdown} />
      <PreviewFade />
    </YStack>
  );
}

function PreviewLoading() {
  return (
    <YStack height={ARTIFACT_MAX_PREVIEW_HEIGHT} alignItems="center" justifyContent="center" testID="artifact-preview-loading">
      <T color="secondary">▧</T>
    </YStack>
  );
}

function PreviewFailed() {
  return (
    <YStack paddingHorizontal="5" testID="artifact-preview-failed">
      <IndexRow inset="flush" title="Preview unavailable" />
    </YStack>
  );
}

/** Canvas over the crop's foot, so a cut-off preview reads as continuing. */
function PreviewFade() {
  return <YStack pointerEvents="none" position="absolute" left={0} right={0} bottom={0} height={44} backgroundColor="canvas" opacity={0.8} />;
}

/** One square photo step over the image: 44, stroked, on canvas. */
function PhotoStep({ children, ...rest }: {
  children: React.ReactNode; accessibilityLabel: string; accessibilityRole: 'button'; testID: string;
  onPress: (event?: { stopPropagation: () => void }) => void;
}) {
  return (
    <YStack {...rest} width={44} height={44} alignItems="center" justifyContent="center" borderWidth={1} borderColor="stroke" borderRadius="sm" backgroundColor="canvas">
      {children}
    </YStack>
  );
}

// Referenced by tests and the cache module's key derivation.
export { mediaIdFromUrl } from '@/buzz/artifact';
