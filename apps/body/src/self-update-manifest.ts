import { downloadBytes } from './update-download.js';

export interface PublishedBundle {
  /** Archive filename, resolved relative to the manifest URL's directory. */
  file: string;
  /** sha256 hex digest of the archive. A mismatch aborts the update loudly. */
  sha256: string;
  bytes?: number;
  /** Source commit the bundle was built from. */
  commit?: string;
  /** Human/comparable version string (e.g. `0.1.0` or a date-based scheme). */
  version?: string;
  node?: string;
}

const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/usebeeline/dist-tags';
const RELEASES_URL = 'https://downloads.usebeeline.app/dl/releases';

async function readChannelVersion(
  channel: string,
  fetchImpl?: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  if (channel !== 'latest' && channel !== 'next') throw new Error(`invalid helper release channel: ${channel}`);
  const raw = await downloadBytes(DIST_TAGS_URL, fetchImpl, {
    request: { headers: { 'Cache-Control': 'no-cache' }, signal },
  });
  const tags = JSON.parse(Buffer.from(raw).toString('utf8')) as Record<string, unknown> | null;
  const version = tags?.[channel];
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?$/.test(version)) {
    throw new Error(`usebeeline npm dist-tag ${channel} has no valid helper version`);
  }
  return `v${version}`;
}

/** Resolve the npm channel to one immutable release, or read an explicit manifest override. */
export async function readPublishedBundle(
  platform: string,
  {
    env = process.env,
    releaseChannel = env.BEELINE_UPDATE_RELEASE_CHANNEL || env.BEELINE_RELEASE_CHANNEL?.trim() || 'latest',
    fetchImpl,
    signal,
  }: { env?: NodeJS.ProcessEnv; releaseChannel?: string; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ url: string; bundle: PublishedBundle }> {
  const override = env.BEELINE_UPDATE_MANIFEST_URL?.trim();
  const version = override ? undefined : await readChannelVersion(releaseChannel, fetchImpl, signal);
  const url = override || `${RELEASES_URL}/${version}/manifest.json`;
  const raw = await downloadBytes(url, fetchImpl, { request: { signal } });
  return { url, bundle: parseUpdateBundle(Buffer.from(raw).toString('utf8'), platform, version) };
}

/**
 * Parse + validate a published manifest for one platform. Throws with a
 * plain reason on anything unusable — the caller reports that and leaves the
 * installed bundle untouched.
 */
function parseUpdateBundle(raw: string, platform: string, expectedVersion?: string): PublishedBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`update manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('update manifest is not an object');
  }
  const manifest = parsed as Record<string, unknown>;
  if (expectedVersion && manifest.version !== expectedVersion) {
    throw new Error(`update manifest does not match npm version ${expectedVersion}`);
  }
  const bundles = manifest.bundles;
  if (typeof bundles !== 'object' || bundles === null) {
    throw new Error('update manifest has no bundles table');
  }
  const entry = (bundles as Record<string, unknown>)[platform];
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`update manifest has no bundle for platform ${platform}`);
  }
  const bundle = entry as Record<string, unknown>;
  const file = typeof bundle.file === 'string' ? bundle.file : '';
  const sha256 = typeof bundle.sha256 === 'string' ? bundle.sha256.toLowerCase() : '';
  if (!file || !/^[a-z0-9][a-z0-9._-]*$/i.test(file)) {
    throw new Error(`update manifest names an unusable bundle file: ${JSON.stringify(bundle.file)}`);
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`update manifest carries no usable sha256 for ${platform}`);
  }
  const sourceCommit =
    typeof bundle.commit === 'string' && bundle.commit
      ? bundle.commit
      : typeof manifest.sourceCommit === 'string'
        ? manifest.sourceCommit
        : undefined;
  const version =
    typeof bundle.version === 'string' && bundle.version
      ? bundle.version
      : typeof manifest.version === 'string'
        ? manifest.version
        : undefined;
  return {
    file,
    sha256,
    ...(typeof bundle.bytes === 'number' ? { bytes: bundle.bytes } : {}),
    ...(sourceCommit ? { commit: sourceCommit } : {}),
    ...(version ? { version } : {}),
    ...(typeof bundle.node === 'string' ? { node: bundle.node } : {}),
  };
}

export interface InstalledBundleIdentity {
  commit?: string;
  version?: string;
}

export type UpdateVerdict =
  | { kind: 'current' }
  | { kind: 'update-available'; published: PublishedBundle }
  | { kind: 'indeterminate'; reason: string };

/**
 * Compare the installed bundle's identity against the published one. Commit
 * identity is primary (the publisher rolls from `main`, so any different
 * source commit is a newer bundle); a comparable version is the fallback when
 * commits are absent on either side. When neither side can be named, the
 * verdict is deliberately `indeterminate` — the automatic path never applies
 * an update it cannot reason about, and the operator's explicit
 * `beeline update --force` is the only thing that overrides that.
 */
export function compareBundleIdentity(
  installed: InstalledBundleIdentity | undefined,
  published: PublishedBundle,
): UpdateVerdict {
  if (installed?.version && published.version && installed.version !== published.version) {
    const installedNewer = versionAtLeast(installed.version, published.version);
    const publishedNewer = versionAtLeast(published.version, installed.version);
    if (installedNewer && !publishedNewer) return { kind: 'current' };
    if (publishedNewer && !installedNewer) return { kind: 'update-available', published };
  }
  if (installed?.commit && published.commit) {
    if (installed.commit === published.commit) return { kind: 'current' };
    return { kind: 'update-available', published };
  }
  if (installed?.version && published.version) {
    const ordering = compareVersions(installed.version, published.version);
    if (ordering > 0) return { kind: 'current' };
    if (ordering < 0) return { kind: 'update-available', published };
    if (installed.commit && published.commit) return { kind: 'current' };
    // Equal versions but unknown commits: the publisher rolls, so treat a
    // same-version republish as current rather than churning installs.
    return { kind: 'current' };
  }
  const missing = [
    ...(installed?.commit || installed?.version ? [] : ['installed identity']),
    ...(published.commit || published.version ? [] : ['published identity']),
  ];
  return {
    kind: 'indeterminate',
    reason: `cannot compare: ${missing.join(' and ')} unknown`,
  };
}

/**
 * Compare two dotted version strings numerically where possible
 * (`0.2.10` > `0.2.9`), falling back to a plain inequality when the shapes
 * are not comparable. Returns positive when `a` is newer, negative when `b`
 * is, and 0 when they read as the same version.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): (number | string)[] | undefined => {
    const parts = value.split(/[.+-]/).filter(Boolean);
    if (parts.length === 0) return undefined;
    return parts.map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return a === b ? 0 : a > b ? 1 : -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const l = left[index];
    const r = right[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    if (typeof l === 'number' && typeof r === 'number') return l > r ? 1 : -1;
    return String(l) > String(r) ? 1 : -1;
  }
  return 0;
}

export function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(value);
    return match ? [...match.slice(1, 4).map(Number), match[4] === undefined ? Infinity : Number(match[4])] : undefined;
  };
  const left = parse(actual),
    right = parse(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 4; index++)
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  return true;
}
