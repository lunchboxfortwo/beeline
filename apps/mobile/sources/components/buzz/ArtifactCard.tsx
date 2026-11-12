import { appReadErrorCopy } from '@/buzz/app-error-copy';
import { useArtifactRecoveryGeneration } from '@/buzz/use-artifact-recovery';
import { IndexRow } from './IndexRow';
import { ArtifactCardFrame, ArtifactFileRow } from '@/ui/screens/transcript/cards/ArtifactCardFrame';
import React, { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { Image, XStack, YStack } from 'tamagui';
import { ChevronLeft, ChevronRight, FileText, Image as ImageIcon } from 'lucide-react-native';
import { Copy, Glyph, HEIGHT, T, TypedView } from '@/ui/grammar';
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
import { ARTIFACT_GROUP_VISIBLE_ROWS, authorKindLine, fileKindLine } from '@/buzz/artifact-group';

export { artifactKindWord } from '@/buzz/artifact-group';
import { openArtifactInDesktopWorkPane } from '@/buzz/desktop-artifact-pane';
import { ArtifactImage, ArtifactText } from '@/components/buzz/ArtifactMedia';
import { ArtifactViewerScreen } from '@/components/buzz/ArtifactViewer';
import { currentViewerConversation } from '@/buzz/viewer-conversation';
import { MonoMarkdown } from '@/components/buzz/MonoMarkdown';
import { Modal } from '@/modal';

/** Reopen the same artifact surface from a card or transcript reference. */
export function openArtifactViewer(attachment: AttachmentReference, isDesktop = false,
  roomId = currentViewerConversation()?.roomId, authorHandle = attachment.author,
  groupAttachments?: readonly AttachmentReference[]) {
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
      // The pane pages through the whole message, as the viewer does.
      ...(groupAttachments && groupAttachments.length > 1 ? { groupAttachments } : {}),
    })
  )
    return;
  Modal.show({
    component: ArtifactViewerScreen,
    props: {
      attachment,
      authorHandle,
      roomId,
      ...(groupAttachments && groupAttachments.length > 1 ? { groupAttachments } : {}),
    },
    // The viewer is a full-screen surface: the default centered placement
    // constrains width to 460 and no height, collapsing its flex:1 root to
    // nothing — a dimmed room with an invisible viewer.
    placement: 'fill',
  });
}

function previewSurface(isDesktop: boolean) {
  return isDesktop ? 'desktop' : Platform.OS === 'ios' ? 'ios' : 'android';
}

/**
 * Visible cards use an excerpt, thumbnail, or bounded sandbox render. Hidden
 * transcript rows retain the same frame without starting a byte request.
 * A message with two or more live files passes them all as `groupAttachments`
 * and draws one stacked card.
 */
export const ArtifactCard = React.memo(function ArtifactCard({
  attachment,
  authorHandle,
  isDesktop = false,
  groupAttachments,
  visible = true,
}: {
  visible?: boolean;
  attachment: AttachmentReference;
  authorHandle?: string;
  isDesktop?: boolean;
  /** Every live artifact of the same message. Omitted for one file. */
  groupAttachments?: readonly AttachmentReference[];
}) {
  if (groupAttachments && groupAttachments.length > 1) {
    return (
      <ArtifactStackCard
        files={groupAttachments}
        authorHandle={authorHandle}
        isDesktop={isDesktop}
        visible={visible}
      />
    );
  }
  return (
    <ArtifactSingleCard
      attachment={attachment}
      authorHandle={authorHandle}
      isDesktop={isDesktop}
      visible={visible}
    />
  );
});

function ArtifactSingleCard({ attachment, authorHandle, isDesktop, visible }: {
  attachment: AttachmentReference; authorHandle?: string; isDesktop: boolean; visible: boolean;
}) {
  const activeAuthorHandle = attachment.author ?? authorHandle;
  const format = artifactFormat(attachment.mimeType);
  const capabilities = artifactCapabilities(attachment.mimeType, previewSurface(isDesktop));
  const title = attachment.title ?? attachment.name;
  const kindLine = authorKindLine(attachment, authorHandle);
  const openFull = useCallback(() => {
    openArtifactViewer(attachment, isDesktop, currentViewerConversation()?.roomId, activeAuthorHandle);
  }, [attachment, activeAuthorHandle, isDesktop]);

  // What nothing on the device can paint (a ZIP, an octet-stream) is one row;
  // the viewer says “Preview unavailable” and offers Open in browser.
  if (capabilities.preview === 'external') {
    return (
      <ArtifactFileRow
        title={title}
        kindLine={kindLine}
        onOpen={openFull}
        testID={`artifact-document-${attachment.name}`}
      />
    );
  }
  return (
    <ArtifactCardFrame
      title={title}
      kindLine={kindLine}
      onOpen={openFull}
      testID={`artifact-${format}-${attachment.name}`}
      preview={<YStack
        minWidth={0}
        accessibilityLabel={`Open ${title} full screen`}
        accessibilityRole="button"
        onPress={openFull}
        testID={`artifact-preview-${attachment.name}`}
      >
        <ArtifactPreviewBody attachment={attachment} visible={visible} />
      </YStack>}
    />
  );
}

/** The cropped preview of one file, by format. */
function ArtifactPreviewBody({ attachment, visible }: { attachment: AttachmentReference; visible: boolean }) {
  const format = artifactFormat(attachment.mimeType);
  if (!visible) return <PreviewLoading />;
  if (format === 'markdown') return <ArtifactMarkdownPreview attachment={attachment} />;
  if (format === 'text') {
    return (
      <YStack height={ARTIFACT_MAX_PREVIEW_HEIGHT}>
        <ArtifactText attachment={attachment} crop testID="artifact-preview-text" />
        <PreviewFade />
      </YStack>
    );
  }
  if (format === 'image') {
    return (
      <YStack height={ARTIFACT_MAX_PREVIEW_HEIGHT}>
        <ArtifactImage attachment={attachment} fit="cover" testID="artifact-preview-image" />
      </YStack>
    );
  }
  return (
    <ArtifactSandboxPreview
      attachment={attachment}
      format={format === 'pdf' ? 'pdf' : format === 'svg' ? 'svg' : 'html'}
    />
  );
}

/**
 * Two or more live files of one message in one card (approved stacked mock):
 * the selected file's preview with arrows and “1 of N”, its title and kind
 * line, one row per file, and one Open. The preview box and every row have a
 * fixed height, so stepping through the files never moves the transcript.
 */
function ArtifactStackCard({ files, authorHandle, isDesktop, visible }: {
  files: readonly AttachmentReference[]; authorHandle?: string; isDesktop: boolean; visible: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setIndex((current) => Math.min(current, files.length - 1));
  }, [files.length]);
  const active = files[Math.min(index, files.length - 1)]!;
  const activeAuthorHandle = active.author ?? authorHandle;
  const title = active.title ?? active.name;
  const external = artifactCapabilities(active.mimeType, previewSurface(isDesktop)).preview === 'external';
  const openFull = useCallback(() => {
    openArtifactViewer(active, isDesktop, currentViewerConversation()?.roomId, activeAuthorHandle, files);
  }, [active, activeAuthorHandle, files, isDesktop]);
  const step = (direction: -1 | 1) => setIndex((current) => (current + direction + files.length) % files.length);
  const shownFiles = expanded ? files : files.slice(0, ARTIFACT_GROUP_VISIBLE_ROWS);
  const hiddenCount = files.length - shownFiles.length;
  const selectionFolded = index >= shownFiles.length;
  return (
    <ArtifactCardFrame
      title={title}
      kindLine={`${authorKindLine(active, authorHandle)} · ${files.length} files`}
      onOpen={openFull}
      testID="artifact-stack"
      preview={
        <YStack
          minWidth={0}
          height={ARTIFACT_MAX_PREVIEW_HEIGHT}
          // Web views are not positioned by default; the arrows anchor here.
          position="relative"
          overflow="hidden"
          accessibilityLabel={`Open ${title} full screen`}
          accessibilityRole="button"
          onPress={openFull}
          testID={`artifact-preview-${active.name}`}
        >
          {external ? (
            <YStack flex={1} alignItems="center" justifyContent="center" gap="1" padding="4" testID="artifact-preview-unavailable">
              <Copy>Preview unavailable</Copy>
              <Copy small quiet>Open the file to view it.</Copy>
            </YStack>
          ) : (
            <ArtifactPreviewBody key={active.url} attachment={active} visible={visible} />
          )}
          <XStack pointerEvents="box-none" position="absolute" left={8} right={8} bottom={8} alignItems="center" justifyContent="space-between">
            <PreviewStep
              accessibilityLabel="Previous file"
              accessibilityRole="button"
              onPress={(event) => { event?.stopPropagation(); step(-1); }}
              testID="artifact-stack-previous"
            >
              <Glyph icon={ChevronLeft} size={14} color="ink" />
            </PreviewStep>
            <T
              v="code"
              accessibilityLabel={`File ${index + 1} of ${files.length}`}
              accessibilityLiveRegion="polite"
              backgroundColor="canvas"
              borderRadius="sm"
              paddingHorizontal="2"
              paddingVertical="1"
              testID="artifact-stack-position"
            >
              {`${index + 1} of ${files.length}`}
            </T>
            <PreviewStep
              accessibilityLabel="Next file"
              accessibilityRole="button"
              onPress={(event) => { event?.stopPropagation(); step(1); }}
              testID="artifact-stack-next"
            >
              <Glyph icon={ChevronRight} size={14} color="ink" />
            </PreviewStep>
          </XStack>
        </YStack>
      }
      rows={
        <YStack testID="artifact-stack-rows">
          {shownFiles.map((file, rowIndex) => {
            const selected = rowIndex === index;
            const fileTitle = file.title ?? file.name;
            return (
              <XStack
                key={file.url}
                minHeight={HEIGHT.control}
                alignItems="center"
                gap="3"
                borderTopWidth={1}
                borderColor="stroke"
                accessibilityRole="button"
                accessibilityLabel={`Show ${fileTitle}`}
                accessibilityState={{ selected }}
                onPress={() => setIndex(rowIndex)}
                testID={`artifact-stack-row-${rowIndex}`}
              >
                <Glyph icon={fileGlyph(file.mimeType)} size={16} accent={selected} />
                <YStack flex={1} minWidth={0}>
                  <Copy strong={selected} numberOfLines={1}>{fileTitle}</Copy>
                  <Copy small quiet numberOfLines={1}>{fileKindLine(file)}</Copy>
                </YStack>
                <Glyph icon={ChevronRight} size={14} />
              </XStack>
            );
          })}
          {hiddenCount > 0 ? (
            <XStack
              minHeight={HEIGHT.control}
              alignItems="center"
              gap="3"
              borderTopWidth={1}
              borderColor="stroke"
              accessibilityRole="button"
              accessibilityState={{ selected: selectionFolded }}
              onPress={() => setExpanded(true)}
              testID="artifact-stack-more"
            >
              {/* Lines up with the file titles, past the row glyph. */}
              <YStack width={16} />
              {/* A selected file under the fold marks the fold, so the list
                  always shows where the selection is. */}
              <Copy small quiet={!selectionFolded} strong={selectionFolded}>{`Show ${hiddenCount} more`}</Copy>
            </XStack>
          ) : null}
        </YStack>
      }
    />
  );
}

/** Pictures use the image mark; other files use the approved document mark. */
function fileGlyph(mimeType: string) {
  const format = artifactFormat(mimeType);
  if (format === 'image') return ImageIcon;
  return FileText;
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

/** One square step over the preview: 44, stroked, on canvas. */
function PreviewStep({ children, ...rest }: {
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
