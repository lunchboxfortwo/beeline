import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  getItem: vi.fn(async (_key: string): Promise<string | null> => null),
  setItem: vi.fn(async () => undefined),
  removeItem: vi.fn(async () => undefined),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
vi.mock('./draft-identity', () => ({ useDraftIdentity: (identity: string) => identity }));
import { useTextDraft } from './use-text-draft';

it('opens an empty composer once and keeps edits and a replacement Room reactive', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const frames: string[] = [];
  let change!: (text: string) => void;
  function Composer({ room, initialEdit }: { room: string; initialEdit?: string }) {
    const [text, setText] = useTextDraft(room, '', 'viewer');
    React.useLayoutEffect(() => { if (initialEdit) setText(initialEdit); }, [initialEdit]);
    frames.push(text);
    change = setText;
    return null;
  }
  let tree!: ReturnType<typeof create>;
  try {
    await act(async () => { tree = create(<Composer room="first" />); });
    expect(frames).toEqual(['']);
    act(() => change('draft'));
    expect(frames.at(-1)).toBe('draft');
    storage.getItem.mockImplementation(async key => key.endsWith(':second') ? JSON.stringify('saved') : null);
    await act(async () => { tree.update(<Composer room="second" />); });
    expect(frames.at(-1)).toBe('saved');
    act(() => change('edited'));
    expect(frames.at(-1)).toBe('edited');
    await act(async () => { tree.update(<Composer key="replacement" room="third" initialEdit="typed during mount" />); });
    expect(frames.at(-1)).toBe('typed during mount');
  } finally {
    act(() => tree.unmount());
  }
});
