import React from 'react';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { artifactFormat } from '@/buzz/artifact';
import { ArtifactCard } from '@/components/buzz/ArtifactCard';
import { useIsDesktop } from '@/utils/responsive';

/**
 * The image the asking message carries, full width under the ask (build spec
 * decision 17: the real screenshot shows in the thread and opens the viewer).
 */
export function RequestMedia({ message }: { message: ChatDisplayMessage }) {
    const desktop = useIsDesktop();
    const image = message.attachments?.find(
        (attachment) => !attachment.expired && artifactFormat(attachment.mimeType) === 'image',
    );
    if (!image) return null;
    const author = message.authorIdentity?.kind === 'agent'
        ? (message.authorIdentity.handle ?? message.authorIdentity.name).replace(/^@/, '')
        : undefined;
    return <ArtifactCard attachment={image} authorHandle={image.author ?? author} isDesktop={desktop} />;
}
