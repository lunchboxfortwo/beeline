import type { LocalSettings } from '@/sync/localSettings';
import { setAndroidNightMode } from './android-launch-appearance-native';

/** The settings store owns the choice; Android persists its native night mode. */
export function applyEffectiveAndroidLaunchAppearance(choice: LocalSettings['appearance']): void {
  setAndroidNightMode(choice);
}

export function pinAndroidLaunchAppearance(appearance: LocalSettings['appearance']): void {
  setAndroidNightMode(appearance);
}
