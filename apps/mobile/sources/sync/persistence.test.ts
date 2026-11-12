import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    getString(key: string) { return store.get(key); }
    set(key: string, value: string) { store.set(key, value); }
    delete(key: string) { store.delete(key); }
    getAllKeys() { return [...store.keys()]; }
  },
}));
vi.mock('@/utils/web-storage', () => ({ webRuntimeStorage: () => null }));

import { loadLocalSettings, migrateStonePalette, saveLocalSettings } from './persistence';
import { applyLocalSettings } from './localSettings';

// Reproduction S2: Stone is the colour set for new and existing installs.
describe('Stone colour set default', () => {
  beforeEach(() => store.clear());

  it('opens a fresh install in Stone', () => {
    migrateStonePalette();
    expect(loadLocalSettings().palette).toBe('stone');
  });

  it('moves an install with saved Brass to Stone once, keeps other settings and a later Brass choice', () => {
    saveLocalSettings({ ...loadLocalSettings(), palette: 'brass', appearance: 'dark', uiSize: 'large' });
    migrateStonePalette();
    expect(loadLocalSettings()).toMatchObject({ palette: 'stone', appearance: 'dark', uiSize: 'large' });
    saveLocalSettings(applyLocalSettings(loadLocalSettings(), { palette: 'brass' }));
    migrateStonePalette();
    expect(loadLocalSettings().palette).toBe('brass');
  });
});
