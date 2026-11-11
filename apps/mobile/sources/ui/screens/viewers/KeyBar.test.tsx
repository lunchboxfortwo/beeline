import { describe, expect, it, vi } from 'vitest';

vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import { BROWSER_KEYS, fieldEdits } from './KeyBar';

describe('the shared browser key bar', () => {
    it('turns each field edit into Backspaces then typed text', () => {
        expect(fieldEdits('', 'LG')).toEqual({ backspaces: 0, text: 'LG' });
        expect(fieldEdits('LG', 'LGTM')).toEqual({ backspaces: 0, text: 'TM' });
        expect(fieldEdits('LGTM', 'LG')).toEqual({ backspaces: 2, text: '' });
        // An autocorrect replacement erases back to the common prefix and retypes.
        expect(fieldEdits('teh', 'the')).toEqual({ backspaces: 2, text: 'he' });
    });

    it('offers Esc, Tab, Backspace, Enter and the four arrows by their page key names', () => {
        expect(BROWSER_KEYS.map((key) => key.key)).toEqual(
            ['Escape', 'Tab', 'Backspace', 'Enter', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight']);
    });
});
