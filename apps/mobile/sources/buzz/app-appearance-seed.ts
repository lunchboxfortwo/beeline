import { Appearance } from 'react-native';
import type { LocalSettings } from '@/sync/localSettings';

export function resolveAppAppearance(
  appearance: LocalSettings['appearance'],
  systemScheme = Appearance.getColorScheme(),
): 'light' | 'dark' {
  return appearance === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : appearance;
}
