import { afterEach, expect, it, vi } from 'vitest';

const constants = vi.hoisted(() => ({
  expoConfig: { version: '0.2.22', extra: { app: {} } },
  manifest2: { metadata: { branchName: 'release-v0.1.244' } },
}));
vi.mock('expo-constants', () => ({ default: constants }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it('recovers the running OTA release from its branch when the release stamp is missing', async () => {
  vi.stubEnv('EXPO_PUBLIC_BEELINE_RELEASE_VERSION', '');
  const { loadAppConfig } = await import('./appConfig');
  expect(loadAppConfig()).toMatchObject({ releaseVersion: 'v0.1.244', appVersion: '0.2.22' });
});

it('reads the release stamp bundled by the exporter', async () => {
  vi.stubEnv('EXPO_PUBLIC_BEELINE_RELEASE_VERSION', 'v0.1.245-rc.10');
  const { loadAppConfig } = await import('./appConfig');
  expect(loadAppConfig().releaseVersion).toBe('v0.1.245-rc.10');
});
