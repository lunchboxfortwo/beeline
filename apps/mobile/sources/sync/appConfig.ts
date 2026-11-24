import Constants from 'expo-constants';

export interface AppConfig {
  postHogKey?: string;
  consoleLoggingDefault?: boolean;
  buildCommitSha?: string;
  buildCommitTimestamp?: string;
  appVersion?: string;
  releaseVersion?: string;
  releaseSha?: string;
  buzzyMonolithUrl?: string;
}

let sessionConfig: AppConfig | undefined;

/**
 * Loads the running bundle's app configuration once per app session.
 */
export function loadAppConfig(): AppConfig {
  if (sessionConfig) return sessionConfig;
  const config: AppConfig = {};

  try {
    const expoConfig = Constants.expoConfig;
    const appConfig = expoConfig?.extra?.app;
    if (appConfig && typeof appConfig === 'object') Object.assign(config, appConfig);
    config.appVersion = expoConfig?.version;
    const metadata = Constants.manifest2?.metadata as { branchName?: unknown } | undefined;
    if (typeof metadata?.branchName === 'string') {
      config.releaseVersion ??= /^release-(v\d+\.\d+\.\d+(?:-rc\.\d+)?)$/.exec(metadata.branchName)?.[1];
    }
  } catch (e) {
    console.warn('[loadAppConfig] Error accessing Constants.expoConfig:', e);
  }

  // The release exporter stamps the bundle as well as its manifest.
  if (process.env.EXPO_PUBLIC_BEELINE_RELEASE_VERSION) {
    config.releaseVersion = process.env.EXPO_PUBLIC_BEELINE_RELEASE_VERSION;
  }
  if (process.env.EXPO_PUBLIC_BUZZY_MONOLITH_URL) {
    config.buzzyMonolithUrl = process.env.EXPO_PUBLIC_BUZZY_MONOLITH_URL;
  }
  if (process.env.EXPO_PUBLIC_BEELINE_RELEASE_SHA) {
    config.releaseSha = process.env.EXPO_PUBLIC_BEELINE_RELEASE_SHA;
  }
  sessionConfig = config;
  return sessionConfig;
}
