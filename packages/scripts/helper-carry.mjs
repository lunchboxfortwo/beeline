// Carry provenance belongs to the bytes, and survives channel promotion.
export function carryHelperPlatform(platform, bundle) {
  const previous = bundle.carriedFrom?.releases ?? (bundle.carriedFrom ? NaN : 0);
  if (!Number.isInteger(previous) || previous < 0)
    throw new Error(`${platform} carry count is unknown; rebuild the helper`);
  const releases = previous + 1;
  if (releases > 3) throw new Error(`${platform} carried for more than 3 releases; rebuild the helper`);
  return { ...bundle, carriedFrom: { commit: bundle.commit, version: bundle.version, sha256: bundle.sha256, releases } };
}
