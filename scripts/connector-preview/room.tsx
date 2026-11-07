// Static marketing fixture. The header, transcript, faces and composer are the app's own components.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, Text } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { ChannelHeaderTitle } from '../../apps/mobile/sources/components/buzz/ChannelHeaderTitle';
import { LedgerEntry } from '../../apps/mobile/sources/components/buzz/Ledger';
import { ConversationComposer } from '../../apps/mobile/sources/components/buzz/ConversationComposer';
const noop = () => {};
function Room() {
  const { theme } = useUnistyles();
  const t = theme.buzz;
  return (
    <View style={{ width: 390, height: 640, backgroundColor: t.bgTerminal, paddingTop: 24 }}>
      <View
        style={{
          paddingHorizontal: 24,
          paddingBottom: 16,
          borderBottomWidth: 1,
          borderBottomColor: t.border,
        }}
      >
        <Text style={{ ...t.type.meta, color: t.textSecondary, marginBottom: 8 }}>Alex’s team</Text>
        <ChannelHeaderTitle title="#general" kind="room" numberOfLines={0} />
      </View>
      <View style={{ flex: 1, paddingHorizontal: 24, paddingTop: 24 }}>
        <LedgerEntry
          itemId="human"
          bodyTestID="preview-human"
          bodyText="What should we work on first?"
          chronological
          byline={{
            name: 'Alex',
            stamp: '09:41',
            isViewer: true,
            mark: { seed: 'connector-preview-alex', kind: 'human', face: 'fox' },
          }}
        />
        <LedgerEntry
          itemId="agent"
          bodyTestID="preview-agent"
          bodyText="Tell me what you’d like to build. We can work together here."
          chronological
          byline={{
            name: 'Codex',
            stamp: '09:41',
            mark: { seed: 'connector-preview-codex', kind: 'agent', face: 'owl' },
          }}
        />
      </View>
      <View style={{ paddingHorizontal: 16, paddingBottom: 24 }}>
        <ConversationComposer
          value=""
          height={44}
          focused={false}
          disabled={false}
          hasAgentMembers
          speechEnabled={false}
          onBlur={noop}
          onChangeText={noop}
          onContentSizeChange={noop}
          onFocus={noop}
          onKeyPress={noop}
          onSend={noop}
        />
      </View>
    </View>
  );
}
createRoot(document.getElementById('root')!).render(<Room />);
