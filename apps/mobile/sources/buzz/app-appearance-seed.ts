import { Appearance } from 'react-native';
import type { LocalSettings } from '@/sync/localSettings';
import { loadLocalSettings, migrateStonePalette, migrateSystemAppearance } from '@/sync/persistence';

export function resolveAppAppearance(
  appearance: LocalSettings['appearance'],
  systemScheme = Appearance.getColorScheme(),
): 'light' | 'dark' {
  return appearance === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : appearance;
}

/** Run before any settings consumers mount. */
export function seedAppAppearanceFromSystem(): 'light' | 'dark' {
  migrateSystemAppearance();
  migrateStonePalette();
  return resolveAppAppearance(loadLocalSettings().appearance);
}
