import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const updates = vi.hoisted(() => ({ check: vi.fn(), reload: vi.fn() }));
const platform = vi.hoisted(() => ({ OS: 'ios' }));
vi.mock('@/hooks/useUpdates', () => ({
  checkNativeUpdate: updates.check,
  reloadNativeUpdate: updates.reload,
}));
vi.mock('@/buzz/client-error-report', () => ({ reportClientError: vi.fn(async () => {}) }));
vi.mock('react-native', () => ({
  Platform: platform,
  Appearance: { getColorScheme: () => 'light' },
}));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
const settings = vi.hoisted(() => ({ appearance: 'dark', palette: 'stone' }));
vi.mock('@/sync/storage', () => ({ useLocalSetting: () => 'medium', storage: { getState: () => ({ localSettings: settings }) } }));
vi.mock('@/ui/tamagui.config', () => ({ tamaguiConfig: {}, themeName: (mode: string, palette: string) => `${mode}_${palette}` }));

import { RuntimeErrorView } from './RuntimeErrorBoundary';

let tree: ReactTestRenderer;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  platform.OS = 'ios';
  updates.check.mockReset().mockResolvedValue({ available: false });
  updates.reload.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => { if (tree) await act(async () => tree.unmount()); });

async function render(scope: 'app' | 'conversation' = 'app', retry = vi.fn()) {
  await act(async () => {
    tree = create(<RuntimeErrorView error={new Error('Broken screen')} retry={retry} scope={scope} />);
  });
}

it.each(['ios', 'android'])('checks once and applies a downloaded update on the %s app error screen', async (os) => {
  platform.OS = os;
  updates.check.mockResolvedValue({ available: true, isNew: true, identity: {} });
  await render();
  expect(updates.check).toHaveBeenCalledOnce();
  expect(updates.reload).toHaveBeenCalledOnce();

  await act(async () => {
    tree.update(<RuntimeErrorView error={new Error('Another render')} retry={vi.fn()} scope="app" />);
  });
  expect(updates.check).toHaveBeenCalledOnce();
  expect(updates.reload).toHaveBeenCalledOnce();
});

it('keeps Retry working when no update is ready', async () => {
  const retry = vi.fn();
  await render('app', retry);
  expect(updates.check).toHaveBeenCalledOnce();
  expect(updates.reload).not.toHaveBeenCalled();
  const button = tree.root.findByProps({ testID: 'runtime-error-retry' });
  expect(button.props.label).toBe('Retry');
  await act(async () => button.props.onPress());
  expect(retry).toHaveBeenCalledOnce();
  expect(updates.check).toHaveBeenCalledOnce();
});

it.each(['check', 'reload'] as const)('preserves the error screen if the update %s fails', async (stage) => {
  updates.check.mockResolvedValue({ available: true, isNew: true, identity: {} });
  updates[stage].mockRejectedValue(new Error('Update failed'));
  await render();
  expect(tree.root.findByProps({ testID: 'runtime-error-message' }).props.children)
    .toBe('Beeline could not display this screen');
  expect(tree.root.findByProps({ testID: 'runtime-error-retry' }).props.label).toBe('Retry');
  expect(updates.check).toHaveBeenCalledOnce();
  expect(updates.reload).toHaveBeenCalledTimes(stage === 'reload' ? 1 : 0);
});

it('leaves conversation errors to the normal update flow', async () => {
  await render('conversation');
  expect(updates.check).not.toHaveBeenCalled();
  expect(updates.reload).not.toHaveBeenCalled();
});

it('does not check for a native update on web', async () => {
  platform.OS = 'web';
  await render();
  expect(updates.check).not.toHaveBeenCalled();
  expect(updates.reload).not.toHaveBeenCalled();
});

it.each(['stone', 'brass'])('Reproduction STONE-LAUNCH: recovery respects saved %s and dark appearance', async (palette) => {
  settings.palette = palette;
  await render();
  expect(tree.root.findByType('TamaguiProvider').props.defaultTheme).toBe(`dark_${palette}`);
});
