import { installationIdentity } from '@beeline/api-contract/installation-identity';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Identity } from '@beeline/buzz-client';
import * as Crypto from 'expo-crypto';
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';
import { loadAppConfig } from '@/sync/appConfig';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { isTauri } from '@/utils/isTauri';

const DEVICE_ID_KEY = '@beeline/mobile-update-receipt/device-id';
const LEGACY_DEVICE_KEY = 'beeline.diagnostics.legacy-update-id.v1';
let previousDeviceId: string | undefined;
let deviceIdPromise: Promise<string> | null = null;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function runningUpdatePlatform(
  nativePlatform: string,
  desktopShell: boolean,
  desktopPlatform: string | undefined,
): 'ios' | 'android' | 'macos' | 'windows' | 'linux' | null {
  if (nativePlatform === 'ios' || nativePlatform === 'android') return nativePlatform;
  if (!desktopShell) return null;
  if (/mac/i.test(desktopPlatform ?? '')) return 'macos';
  if (/win/i.test(desktopPlatform ?? '')) return 'windows';
  if (/linux/i.test(desktopPlatform ?? '')) return 'linux';
  return null;
}

/** EAS exposes the update group in manifest metadata on current OTA manifests. */
export function runningUpdateGroup(manifest: unknown): string | null {
  const root = object(manifest);
  const metadata = object(root?.metadata);
  const extra = object(root?.extra);
  const eas = object(extra?.eas);
  return (
    string(metadata?.updateGroup) ?? string(root?.updateGroup) ?? string(eas?.updateGroup) ?? null
  );
}

async function installationDeviceId(): Promise<string> {
  deviceIdPromise ??= (async () => {
    try {
      const existing = await AsyncStorage.getItem(DEVICE_ID_KEY);
      const canonical=await installationIdentity(AsyncStorage,Crypto.randomUUID);
      const legacy=existing!==canonical ? existing : await AsyncStorage.getItem(LEGACY_DEVICE_KEY);
      if (legacy && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(legacy)) {
        previousDeviceId=legacy;
        await AsyncStorage.setItem(LEGACY_DEVICE_KEY,legacy);
      }
      if (existing===canonical) return existing;
      const created = canonical;
      await AsyncStorage.setItem(DEVICE_ID_KEY, created);
      return created;
    } catch (error) {
      deviceIdPromise = null;
      throw error;
    }
  })();
  return deviceIdPromise;
}

/**
 * Report the bytes this installation is actually running. This is independent
 * of notification permission and FCM registration, so a push-disabled owner
 * device can still close the OTA delivery loop.
 */
/** The identity and update this JS context already reported; the bytes cannot change under it. */
let reportedRunningUpdate: string | null = null;

export async function reportRunningUpdateReceipt(identity: Identity): Promise<void> {
  const reportKey = `${identity.publicKey}:${Updates.updateId ?? ''}`;
  if (reportedRunningUpdate === reportKey) return;
  const platform = runningUpdatePlatform(
    Platform.OS,
    isTauri(),
    typeof navigator === 'undefined' ? undefined : navigator.platform,
  );
  if (!platform) return;
  // Desktop has no push receipt path; its observation is a phone
  // operation through the same authenticated monolith boundary.
  const release = loadAppConfig();
  await monolithPhoneOperation('reportRunningUpdate', {
    deviceId: await installationDeviceId(),
    ...(previousDeviceId ? { previousDeviceId } : {}),
    platform,
    ...(Updates.updateId ? { updateId: Updates.updateId } : {}),
    ...(Updates.channel ? { channel: Updates.channel } : {}),
    ...(runningUpdateGroup(Updates.manifest)
      ? { group: runningUpdateGroup(Updates.manifest)! }
      : {}),
    ...(Updates.runtimeVersion ? { runtimeVersion: Updates.runtimeVersion } : {}),
    ...(release.releaseVersion ? { releaseVersion: release.releaseVersion } : {}),
    ...(release.releaseSha ? { sourceSha: release.releaseSha } : {}),
  });
  reportedRunningUpdate = reportKey;
}
