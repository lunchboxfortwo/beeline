import React, { useEffect, useState } from 'react';
import type { AttachmentReference } from '@beeline/buzz-client';
import { appReadErrorCopy } from '@/buzz/app-error-copy';
import { fetchArtifactText, subscribeArtifactBytesPurge } from '@/buzz/artifact-link';
import { useArtifactRecoveryGeneration } from '@/buzz/use-artifact-recovery';
import { TypedView } from '@/ui/grammar';
import { ViewerNotice, ViewerPlaceholder, ViewerScroll } from '@/ui/screens/viewers/ViewerChrome';
import { MonoMarkdown } from './MonoMarkdown';

export function ArtifactMarkdown({ attachment, testIDPrefix }: {
  attachment: AttachmentReference;
  testIDPrefix: string;
}) {
  const recovery = useArtifactRecoveryGeneration();
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const stopPurge = subscribeArtifactBytesPurge(attachment, () => {
      controller.abort();
      setMarkdown(null);
      setFailed(true);
    });
    setMarkdown(null);
    setFailed(false);
    void fetchArtifactText(attachment, { signal: controller.signal })
      .then((text) => {
        if (live && !controller.signal.aborted) setMarkdown(text);
      })
      .catch((cause) => {
        if (live && !controller.signal.aborted) setFailed(Boolean(appReadErrorCopy(cause)));
      });
    return () => {
      live = false;
      controller.abort();
      stopPurge();
    };
  }, [attachment, recovery]);

  if (failed) return <ViewerNotice title="Page unavailable" testID={`${testIDPrefix}-failed`} />;
  if (markdown == null) return <ViewerPlaceholder text="Loading…" testID={`${testIDPrefix}-loading`} />;
  return <ArtifactMarkdownBody markdown={markdown} testID={`${testIDPrefix}-markdown`} />;
}

export function ArtifactMarkdownBody({ markdown, testID }: { markdown: string; testID: string }) {
  return (
    <ViewerScroll testID={testID}>
      <TypedView view={MonoMarkdown} markdown={markdown} document />
    </ViewerScroll>
  );
}
