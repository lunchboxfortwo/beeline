export function releaseChannel(value = 'next') {
  if (!['next', 'latest'].includes(value)) throw new Error(`invalid release channel: ${value}`);
  return value;
}

export function channelComponents(selected, { storeTrack = 'none' } = {}) {
  const native = selected.includes('mobile-native');
  if (storeTrack === 'production' || (native && storeTrack !== 'beta')) throw new Error('next native builds require explicit store_track=beta');
  return ['server', 'helper', 'mobile-ota', 'desktop', 'website', ...(native ? ['mobile-native'] : [])];
}
