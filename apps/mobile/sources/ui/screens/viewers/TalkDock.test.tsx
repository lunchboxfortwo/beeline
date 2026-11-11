import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import { TalkDock } from './TalkDock';

const texts = (node: any): string[] => node.findAllByType('Text').flatMap((text: any) =>
    [text.props.children].flat().filter((child: unknown) => typeof child === 'string'));

function render(open: boolean, onToggle = vi.fn()) {
    let tree: any;
    act(() => {
        tree = create(
            <TalkDock open={open} onToggle={onToggle} bottom={12} maxTranscriptHeight={300}
                heading="Recent conversation · alan" showTranscript error={null} contextLabel="Viewing chart.png"
                entries={[{ id: 'a', speaker: 'You', text: 'Make it thinner.', mine: true }, { id: 'b', speaker: '@alan', text: 'Done.', mine: false }]}
                composer={<React.Fragment><Composer /></React.Fragment>} />,
        );
    });
    return tree;
}
function Composer() { return null; }

describe('Talk to agent', () => {
    it('closed: one pill that opens the conversation', () => {
        const onToggle = vi.fn();
        const tree = render(false, onToggle);
        const toggle = tree.root.findByProps({ testID: 'viewer-conversation-toggle' });
        expect(toggle.props.label).toBe('Talk to agent');
        expect(tree.root.findAllByType(Composer)).toHaveLength(0);
        act(() => toggle.props.onPress());
        expect(onToggle).toHaveBeenCalledOnce();
    });

    it('open: recent lines with the speaker, the context chip and the field', () => {
        const tree = render(true);
        expect(tree.root.findByProps({ testID: 'viewer-conversation-toggle' }).props.label).toBe('Collapse conversation');
        const card = tree.root.findByProps({ testID: 'viewer-conversation-transcript' });
        expect(texts(card)).toEqual(expect.arrayContaining(['Recent conversation · alan', 'You: ', 'Make it thinner.', '@alan: ', 'Done.', 'Viewing chart.png']));
        expect(card.findAllByType(Composer)).toHaveLength(1);
    });
});
