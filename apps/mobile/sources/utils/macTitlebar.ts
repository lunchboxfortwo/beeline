import { isTauri } from './isTauri';

/** Shared top titlebar strip height for macOS Tauri Overlay traffic-light clearance. */
export const MAC_TAURI_TITLEBAR_HEIGHT = 34;

export function isMacTauri(): boolean {
  return isTauri() && typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
}
