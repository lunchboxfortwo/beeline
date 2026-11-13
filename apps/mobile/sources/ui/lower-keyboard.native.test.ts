import { describe, expect, it, vi } from 'vitest';

const dismiss = vi.hoisted(() => vi.fn());
vi.mock('react-native', () => ({ Keyboard: { dismiss } }));

import { lowerKeyboard } from './lower-keyboard.native';

describe('lowerKeyboard on a phone', () => {
    it('dismisses the keyboard so an opening sheet is not drawn under it', () => {
        lowerKeyboard();
        expect(dismiss).toHaveBeenCalledTimes(1);
    });
});
