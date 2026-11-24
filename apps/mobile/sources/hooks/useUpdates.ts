import * as Updates from 'expo-updates';
import { OPERATOR_OWNER_ID } from '@beeline/api-contract/phone';
import { loadBuzzViewerPubkey } from '@/auth/buzz-identity-storage';

type PendingOtaUpdate = { ota_version?: string; ota_runtime_version?: string };
function updateIdentity(manifest: { id?: string; runtimeVersion?: string | null }): PendingOtaUpdate {
    return {
        ota_version: manifest.id,
        ota_runtime_version: manifest.runtimeVersion ?? undefined,
    };
}

type NativeUpdateResult = { available: false; downloadFailed?: boolean } | { available: true; isNew: boolean; identity: { ota_version?: string; ota_runtime_version?: string } };
let nativeFlight: Promise<NativeUpdateResult> | undefined;
let nativeStage: 'available' | 'downloaded' | undefined;
let downloadedChannel: string | undefined;
const nativeObservers = new Set<(stage: 'available' | 'downloaded') => void>();

async function switchNativeChannel(): Promise<(() => void) | undefined> {
    if (!Updates.isEnabled || !Updates.channel) return;
    const previous = downloadedChannel ?? Updates.channel;
    const channel = await loadBuzzViewerPubkey() === OPERATOR_OWNER_ID ? 'next' : 'production';
    if (channel === previous) return;
    Updates.setUpdateRequestHeadersOverride({ 'expo-channel-name': channel });
    return () => {
        if (nativeStage === 'downloaded') {
            downloadedChannel = channel;
        } else {
            // Expo persists the header and uses it to select launchable bundles.
            // Preserve the existing launch channel until a replacement is ready.
            Updates.setUpdateRequestHeadersOverride({ 'expo-channel-name': previous });
        }
    };
}

/** Settings and the automatic owner share this exact SDK flight. */
export function checkNativeUpdate(observer?: (stage: 'available' | 'downloaded') => void): Promise<NativeUpdateResult> {
    if (!nativeFlight) {
        nativeStage = undefined;
        nativeFlight = (async () => {
            const finishChannelSwitch = await switchNativeChannel();
            try {
                const update = await Updates.checkForUpdateAsync();
                if (!update.isAvailable) return { available: false as const };
                nativeStage = 'available'; for (const receive of nativeObservers) receive(nativeStage);
                const fetched = await Updates.fetchUpdateAsync();
                if (!fetched.isNew && !fetched.isRollBackToEmbedded) return { available: false as const, downloadFailed: true };
                const manifest = fetched.manifest as { id?: string; runtimeVersion?: string | null } | undefined;
                if (manifest?.runtimeVersion && Updates.runtimeVersion && manifest.runtimeVersion !== Updates.runtimeVersion)
                    throw new Error('Update runtime is incompatible');
                nativeStage = 'downloaded'; for (const receive of nativeObservers) receive(nativeStage);
                return { available: true as const, isNew: fetched.isNew, identity: updateIdentity(manifest ?? {}) };
            } finally {
                finishChannelSwitch?.();
            }
        })().finally(() => { nativeFlight = undefined; nativeStage = undefined; });
    }
    if (observer) { nativeObservers.add(observer); if (nativeStage) observer(nativeStage); }
    return nativeFlight.finally(() => { if (observer) nativeObservers.delete(observer); });
}
let reloadFlight: Promise<void> | undefined;
export function reloadNativeUpdate(): Promise<void> {
    return reloadFlight ??= Updates.reloadAsync().finally(() => { reloadFlight = undefined; });
}
