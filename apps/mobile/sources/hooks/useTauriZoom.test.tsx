import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({ on: false }));
const setZoom = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('@/utils/isTauri', () => ({ isTauri: () => tauri.on }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ setZoom }) }));
import { useTauriZoom } from './useTauriZoom';

const root = { style: new Map<string, string>(), classList: new Set<string>() };
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    root.style.clear();
    root.classList.clear();
    (globalThis as any).window = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    (globalThis as any).document = { documentElement: root };
    setZoom.mockClear();
});
afterEach(() => { delete (globalThis as any).window; delete (globalThis as any).document; });

function Probe() { useTauriZoom(); return null; }

it('leaves a browser page unzoomed, so Text size is applied once', () => {
    tauri.on = false;
    act(() => { create(<Probe />); });
    expect([...root.classList, ...root.style.keys()]).toEqual([]);
    expect(setZoom).not.toHaveBeenCalled();
});

it('opens the desktop app at zoom 1', async () => {
    tauri.on = true;
    await act(async () => { create(<Probe />); });
    await vi.waitFor(() => expect(setZoom).toHaveBeenCalledWith(1));
});
