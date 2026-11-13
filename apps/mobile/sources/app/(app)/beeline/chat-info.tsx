import { router, useLocalSearchParams, type Href } from 'expo-router';
import { ChatInfoScreen } from '@/ui/screens/chat-info/ChatInfoScreen';

const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

/** Chat info on a phone (the desktop opens it in the right panel). */
export default function ChatInfoRoute() {
    const roomId = first(useLocalSearchParams<{ roomId?: string | string[] }>().roomId) ?? '';
    return (
        <ChatInfoScreen
            roomId={roomId}
            close={() => (router.canGoBack() ? router.back() : router.replace('/beeline/channels' as Href))}
        />
    );
}
