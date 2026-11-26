import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({ on: true }));
const desktop = vi.hoisted(() => ({ on: true }));
vi.mock('@/utils/isTauri', () => ({ isTauri: () => tauri.on }));
vi.mock('@/utils/responsive', () => ({ useHeaderHeight: () => 56, useIsDesktop: () => desktop.on }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));

import { useTauriDrag } from './useTauriDrag';

function Probe() {
  useTauriDrag();
  return null;
}

describe('useTauriDrag', () => {
  const listeners = new Map<string, (e: any) => void>();
  const appended: any[] = [];
  const invoke = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    tauri.on = true;
    desktop.on = true;
    listeners.clear();
    appended.length = 0;
    invoke.mockClear();
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    (globalThis as any).window = {
      __TAURI_INTERNALS__: { invoke },
      getSelection: () => ({ removeAllRanges: vi.fn() }),
    };
    (globalThis as any).document = {
      body: { tagName: 'BODY' },
      head: { appendChild: (el: any) => { appended.push(el); } },
      createElement: () => ({
        attributes: {} as Record<string, string>,
        textContent: '',
        setAttribute(k: string, v: string) { this.attributes[k] = v; },
        remove: vi.fn(),
      }),
      addEventListener: (name: string, fn: (e: any) => void) => { listeners.set(name, fn); },
      removeEventListener: (name: string) => { listeners.delete(name); },
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as any).window;
    delete (globalThis as any).document;
  });

  it('injects no hardcoded brass focus outline and restricts macOS desktop dragging to the 34px titlebar strip', () => {
    let tree: any;
    act(() => { tree = create(<Probe />); });
    try {
      expect(appended).toHaveLength(1);
      expect(appended[0].textContent).not.toContain('#d7af5f');
      expect(appended[0].textContent).not.toContain('outline:');

      const onMouseDown = listeners.get('mousedown')!;
      const plainNode = { tagName: 'DIV', getAttribute: () => null, parentElement: (globalThis as any).document.body };

      // Click inside the 34px macOS titlebar strip starts window dragging.
      onMouseDown({ button: 0, clientY: 20, detail: 1, target: plainNode, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() });
      expect(invoke).toHaveBeenCalledWith('plugin:window|start_dragging');

      invoke.mockClear();
      // Click below the 34px titlebar strip (inside the aligned chat/sidebar header) does not hijack dragging.
      onMouseDown({ button: 0, clientY: 48, detail: 1, target: plainNode, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() });
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      act(() => tree.unmount());
    }
  });
});
