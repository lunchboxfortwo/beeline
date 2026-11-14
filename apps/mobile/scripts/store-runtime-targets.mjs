// Store publication, not an OTA or upload receipt, admits a retention slot.
export const runtimeKey = ({ platform, runtimeVersion }) => `${platform}@${runtimeVersion}`;

export function storeRuntimeTargets({ pins, stores, previouslyLive = [], previousTargets = [], channel = 'production' }) {
  const result = [];
  for (const platform of ['android', 'ios']) {
    const pin = pins[platform];
    if (!/^\d+$/.test(pin)) throw new Error(`Invalid runtime pin: ${platform}@${pin}`);
    const store = stores?.[platform];
    const live = store?.status === 'readable' ? store.live : [];
    if (!Array.isArray(live)) throw new Error(`Invalid ${platform} live store runtimes`);
    if (store?.unknownRuntime) throw new Error(store.unknownRuntime);
    const retained = previousTargets.filter(t => t.platform === platform);
    const known = [...previouslyLive, ...(store?.historical ?? []), ...live,
      ...(channel === 'next' ? [...(store?.betaLive ?? []), ...(store?.warnings?.length ? retained : [])] : [])].filter(t => t.platform === platform);
    const selected = store?.status === 'readable'
      ? [...new Set(known.map(t => t.runtimeVersion))].filter(v => /^\d+$/.test(v))
        .sort((a, b) => BigInt(a) > BigInt(b) ? -1 : 1).slice(0, 3)
        .map(runtimeVersion => ({ platform, runtimeVersion }))
      : retained;
    if (channel === 'next' && store?.status !== 'readable') selected.push(...(store?.betaLive ?? []));
    for (const target of selected) {
      if (target.platform !== platform || !/^\d+$/.test(target.runtimeVersion)) {
        throw new Error(`Invalid store runtime: ${runtimeKey(target)}`);
      }
      if (!result.some(t => runtimeKey(t) === runtimeKey(target))) {
        result.push({ platform, runtimeVersion: target.runtimeVersion });
      }
    }
  }
  return result;
}

export function playLiveBuilds(payload, track = 'production') {
  if (payload?.track !== track) throw new Error(`Invalid Play ${track} track`);
  if (payload.releases !== undefined && !Array.isArray(payload.releases)) throw new Error(`Unreadable Play ${track} releases`);
  // Staged and halted rollouts have installed users who still need OTAs.
  // A draft has never been served. Missing releases is an empty track.
  return (payload.releases ?? []).flatMap(release => {
    if (!['completed', 'inProgress', 'halted', 'draft'].includes(release.status)) {
      throw new Error(`Invalid Play ${track} release status`);
    }
    if (release.status === 'draft') return [];
    if (!Array.isArray(release.versionCodes) || !release.versionCodes.length
      || !release.versionCodes.every(code => typeof code === 'string' && /^\d+$/.test(code))) {
      throw new Error(`Invalid Play ${track} version codes`);
    }
    return release.versionCodes;
  });
}

export function resolveStoreBuilds(platform, buildNumbers, builds) {
  return [...new Set(buildNumbers)].map(buildNumber => {
    const matches = builds.filter(b => b.platform.toLowerCase() === platform && String(b.appBuildVersion ?? b.buildNumber) === buildNumber);
    const versions = [...new Set(matches.map(b => b.runtimeVersion))];
    if (versions.length !== 1 || !/^\d+$/.test(versions[0])) {
      const error = new Error(`Cannot prove runtime of ${platform} store build ${buildNumber}`);
      error.code = 'UNKNOWN_STORE_RUNTIME';
      throw error;
    }
    return { platform, runtimeVersion: versions[0], buildNumber };
  });
}
