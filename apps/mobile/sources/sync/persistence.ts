import { MMKV } from 'react-native-mmkv';
import { webRuntimeStorage } from '@/utils/web-storage';
import { webStringStorage, type BrowserStringStorage } from './browser-string-storage';
import { type Settings, settingsDefaults, settingsParse, settingsToSyncPayload } from './settings';
import { type LocalSettings, localSettingsDefaults, localSettingsParse } from './localSettings';

/** The web build (browser and Tauri) has no MMKV host object. Keep the same
 * synchronous settings contract through browser storage; native keeps MMKV. */
const web = webRuntimeStorage();
const SETTINGS_NAMESPACE = 'beeline.settings.';
const mmkv: BrowserStringStorage = web
  ? webStringStorage(web.storage, SETTINGS_NAMESPACE)
  : new MMKV();

export type SettingsKey = 'settings' | 'local-settings';

/** Another tab wrote these settings. Only the web build shares storage between tabs. */
export function subscribeSettingsWrites(listener: (key: SettingsKey) => void): () => void {
  const shared = web?.storage;
  if (!shared || typeof window.addEventListener !== 'function') return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea !== shared) return;
    for (const key of ['settings', 'local-settings'] as const)
      if (event.key === null || event.key === `${SETTINGS_NAMESPACE}${key}`) listener(key);
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

export function loadSettings(): { settings: Settings; version: number | null } {
  const raw = mmkv.getString('settings');
  if (!raw) return { settings: { ...settingsDefaults }, version: null };
  try {
    const parsed = JSON.parse(raw);
    return { settings: settingsParse(parsed.settings), version: parsed.version ?? null };
  } catch (error) {
    console.error('Failed to parse settings', error);
    return { settings: { ...settingsDefaults }, version: null };
  }
}

export function saveSettings(settings: Settings, version: number): void {
  mmkv.set('settings', JSON.stringify({ settings: settingsToSyncPayload(settings), version }));
}

export function loadLocalSettings(): LocalSettings {
  const boot = typeof window === 'undefined' ? undefined : window.__beelineLaunchSettings;
  const raw = boot ? boot.raw : mmkv.getString('local-settings');
  if (boot) delete window.__beelineLaunchSettings;
  if (!raw) return { ...localSettingsDefaults };
  try {
    return localSettingsParse(JSON.parse(raw));
  } catch (error) {
    console.error('Failed to parse local settings', error);
    return { ...localSettingsDefaults };
  }
}

export function saveLocalSettings(settings: LocalSettings): void {
  mmkv.set('local-settings', JSON.stringify(settings));
}

export function storeTempText(content: string): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  mmkv.set(`temp_text_${id}`, content);
  return id;
}

export function retrieveTempText(id: string): string | null {
  const key = `temp_text_${id}`;
  const content = mmkv.getString(key) ?? null;
  if (content) mmkv.delete(key);
  return content;
}

/** Move existing installations to the Stone colour set once. A Brass choice
 * made after this runs is kept, because the marker stops a second move. */
export function migrateStonePalette(): void {
  if (mmkv.getString('palette-stone-v1') === 'done') return;
  saveLocalSettings({ ...loadLocalSettings(), palette: 'stone' });
  mmkv.set('palette-stone-v1', 'done');
}

let initialLocalSettings: LocalSettings | undefined;
/** One launch read, shared by display initialization and the settings store. */
export function loadInitialLocalSettings(): LocalSettings {
  if (initialLocalSettings) return initialLocalSettings;
  let settings = loadLocalSettings();
  const appearancePending = mmkv.getString('appearance-system-v1') !== 'done';
  const palettePending = mmkv.getString('palette-stone-v1') !== 'done';
  if (appearancePending) settings = { ...settings, appearance: 'system' };
  if (palettePending) settings = { ...settings, palette: 'stone' };
  if (appearancePending || palettePending) saveLocalSettings(settings);
  if (appearancePending) mmkv.set('appearance-system-v1', 'done');
  if (palettePending) mmkv.set('palette-stone-v1', 'done');
  initialLocalSettings = settings;
  return settings;
}
