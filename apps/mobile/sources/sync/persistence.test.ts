import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());
const reads = vi.hoisted(() => [] as string[]);
vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    getString(key: string) { reads.push(key); return store.get(key); }
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

it('Reproduction STONE-LAUNCH: launch consumers share one migrated settings read', async () => {
  vi.resetModules();
  store.clear(); reads.length = 0;
  store.set('local-settings', JSON.stringify({ palette: 'brass', appearance: 'dark', uiSize: 'large' }));
  const persistence = await import('./persistence');
  const first = persistence.loadInitialLocalSettings();
  expect(first).toMatchObject({ palette: 'stone', appearance: 'system', uiSize: 'large' });
  expect(persistence.loadInitialLocalSettings()).toBe(first);
  expect(reads.filter(key => key === 'local-settings')).toHaveLength(1);
});

it('keeps a deliberate Brass choice after migration at launch', async () => {
  vi.resetModules();
  store.clear();
  store.set('palette-stone-v1', 'done');
  store.set('appearance-system-v1', 'done');
  store.set('local-settings', JSON.stringify({ palette: 'brass', appearance: 'dark' }));
  const persistence = await import('./persistence');
  expect(persistence.loadInitialLocalSettings()).toMatchObject({ palette: 'brass', appearance: 'dark' });
});

it('consumes the web head snapshot without reading a second stored choice', async () => {
  vi.resetModules(); store.clear(); reads.length = 0;
  store.set('palette-stone-v1', 'done');
  store.set('appearance-system-v1', 'done');
  const head = { __beelineLaunchSettings: { raw: JSON.stringify({ palette: 'stone', appearance: 'dark' }) } };
  vi.stubGlobal('window', head);
  try {
    const persistence = await import('./persistence');
    expect(persistence.loadInitialLocalSettings()).toMatchObject({ palette: 'stone', appearance: 'dark' });
    expect(reads).not.toContain('local-settings');
    expect(head.__beelineLaunchSettings).toBeUndefined();
  } finally { vi.unstubAllGlobals(); }
});
