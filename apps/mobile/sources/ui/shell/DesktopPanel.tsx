import React, { useEffect } from 'react';
import { usePathname } from 'expo-router';
import { YStack } from 'tamagui';
import { closePanel, usePanel, type PanelPlace } from './panel';
import { MembersScreen } from '@/ui/screens/members/MembersScreen';
import { ChatInfoScreen } from '@/ui/screens/chat-info/ChatInfoScreen';
import { AgentProfileScreen } from '@/ui/screens/profiles/AgentProfileScreen';
import { PersonProfileScreen } from '@/ui/screens/profiles/PersonProfileScreen';
import { BriefScreen } from '@/ui/screens/thread/BriefScreen';

function PanelBody({ place }: { place: PanelPlace }) {
    switch (place.kind) {
        case 'members': return <MembersScreen roomId={place.roomId} close={closePanel} />;
        case 'chat-info': return <ChatInfoScreen roomId={place.roomId} close={closePanel} />;
        case 'agent': return <AgentProfileScreen agentId={place.agentId} workspaceId={place.workspaceId} close={closePanel} />;
        case 'person': return <PersonProfileScreen memberId={place.memberId} workspaceId={place.workspaceId} close={closePanel} />;
        case 'brief': return <BriefScreen roomId={place.roomId} close={closePanel} />;
    }
}

/** The 400 px right panel; switching chats (any route change) closes it. */
export function DesktopPanel() {
    const place = usePanel();
    const pathname = usePathname();
    useEffect(() => { closePanel(); }, [pathname]);
    if (!place) return null;
    return (
        <YStack width={400} flexShrink={0} minHeight={0} borderLeftWidth={1} borderColor="stroke" backgroundColor="canvas" testID="desktop-panel">
            <PanelBody key={JSON.stringify(place)} place={place} />
        </YStack>
    );
}
