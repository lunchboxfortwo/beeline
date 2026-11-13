import { useEffect } from 'react';
import { Platform } from 'react-native';
import { isTauri } from '@/utils/isTauri';

const MIN_APP_ZOOM = 0.5;
const MAX_APP_ZOOM = 2.5;
/**
 * The page zoom at every Text size. Text size picks its own type and spacing
 * presets (GrammarProvider), so zooming the page too would apply it twice.
 */
export const APP_ZOOM = 1;

const clampZoom = (zoom: number) => Math.max(MIN_APP_ZOOM, Math.min(MAX_APP_ZOOM, zoom));

// Cmd/Ctrl+=, Cmd/Ctrl+-, Cmd/Ctrl+0 zoom shortcuts for the Tauri desktop app.
// Uses Tauri's native webview.setZoom — unlike CSS `zoom`, this shrinks the
// layout viewport so matchMedia / window.innerWidth change and responsive
// breakpoints (unistyles etc.) react correctly.
export function useTauriZoom() {
    useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined' || !isTauri()) return;

        let active = true;
        let zoom = APP_ZOOM;
        let webview: { setZoom: (z: number) => Promise<void> } | null = null;

        const apply = (z: number) => {
            zoom = clampZoom(z);
            webview?.setZoom(zoom).catch((e) => console.error('setZoom failed:', e));
        };

        (async () => {
            const { getCurrentWebview } = await import('@tauri-apps/api/webview');
            if (!active) return;
            webview = getCurrentWebview();
            apply(zoom);
        })();

        const onKey = (e: KeyboardEvent) => {
            if ((!e.metaKey && !e.ctrlKey) || e.altKey) return;
            if (e.key === '=' || e.key === '+') {
                e.preventDefault();
                apply(zoom + 0.1);
            } else if (e.key === '-' || e.key === '_') {
                e.preventDefault();
                apply(zoom - 0.1);
            } else if (e.key === '0') {
                e.preventDefault();
                apply(APP_ZOOM);
            }
        };

        window.addEventListener('keydown', onKey);
        return () => {
            active = false;
            window.removeEventListener('keydown', onKey);
        };
    }, []);
}
