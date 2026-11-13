import React from 'react';
import { createRoot } from 'react-dom/client';
import { isPillMessage, foldPillRuns } from '../../apps/mobile/sources/buzz/transcript-pills';
import { agentCommandTranscriptMessage } from '../../apps/mobile/sources/buzz/agent-command-transcript';
import { TranscriptLine } from '../../apps/mobile/sources/ui/screens/transcript/TranscriptLine';
import { PillRow } from '../../apps/mobile/sources/ui/screens/transcript/PillRow';
import { T, Stack } from './hosts';
import type { ChatDisplayMessage } from '../../apps/mobile/sources/buzz/room-view-presentation';

const before = new URLSearchParams(location.search).has('before');
const base = { isUser: false, timestamp: 1794453420, pubkey: 'ruby', isAgentAuthor: true };
const command = (id: string, kind: 'human' | 'agent' | undefined, name: string, text: string): ChatDisplayMessage => ({
  ...base, id, text: `Ruby reported to ${name}`, agentCommand: { kind: 'report',
    recipient: { id: name.toLowerCase(), name, kind }, text },
});
const messages = [
  command('person-report', 'human', 'lunchboxfortwo', 'needs-decision: Choose the endpoint. The current report must be readable without opening a pill.'),
  command('agent-report', 'agent', 'Jellybean', 'done: The agent-only task is complete.'),
  command('legacy-report', undefined, 'lunchboxfortwo', 'blocked: This older report has no recipient kind. Its full text stays visible.'),
];
function App() {
  return <Stack gap="4" padding="6" maxWidth={760}>
    <T v="heading">UAR-1 · {before ? 'Before' : 'After'} · {document.documentElement.dataset.theme}</T>
    <T v="meta">Built transcript component stand-in · person report, agent report, legacy report</T>
    {(before ? messages : foldPillRuns(messages)).map(message => {
      const pill = before ? Boolean(message.agentCommand) : isPillMessage(message);
      return pill ? <PillRow key={message.id} testID={message.id} items={[{
        id: message.id, from: { kind: 'agent', seed: 'ruby', name: 'Ruby', face: 'fox' },
        to: { kind: message.agentCommand!.recipient.kind ?? 'human', seed: message.agentCommand!.recipient.id,
          name: message.agentCommand!.recipient.name }, time: '22:17', system: false,
        body: <T>{message.agentCommand!.text}</T>,
      }]} /> : <TranscriptLine key={message.id} testID={message.id}
        sender={{ name: 'Ruby', stamp: '22:17', mark: { seed: 'ruby', kind: 'agent', face: 'fox' } }}>
        <T>{agentCommandTranscriptMessage(message, []).text}</T>
      </TranscriptLine>;
    })}
  </Stack>;
}
createRoot(document.getElementById('root')!).render(<App />);
