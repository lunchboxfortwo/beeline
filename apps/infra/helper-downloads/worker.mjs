// Keep installed helpers' /dl URLs stable while streaming public R2 objects.
// No download credentials, Pages deployment or archive buffering needed.
const ORIGIN = 'https://downloads.usebeeline.app';
const POINTER = '/latest-release.json';
const RC = /^v\d+\.\d+\.\d+-rc\.[1-9]\d*$/;

export async function serveDownloads(request, fetchImpl = fetch) {
  const path = new URL(request.url).pathname;
  const helper = /^\/dl\/(next\/)?(manifest\.json|beeline-bootstrap\.mjs(?:\.sha256)?|beeline-(?:linux-x64|darwin-arm64|darwin-x64)\.tar\.gz(?:\.sha256)?)$/.exec(path);
  const desktop = /^\/latest\/(Beeline-[a-zA-Z0-9_.-]+)$/.exec(path);
  if (!helper && !desktop) return new Response('Download not found\n', { status: 404 });
  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response('Method not allowed\n', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  let objectPath = path;
  try {
    if (!helper?.[1]) {
      const pointer = await fetchImpl(`${ORIGIN}${POINTER}?channel_check=${Date.now()}`, { cache: 'no-store' });
      if (pointer.ok) {
        const { version } = await pointer.json();
        if (!RC.test(version)) throw new Error('Invalid release pointer');
        objectPath = helper ? `/dl/releases/${version}/${helper[2]}` : `/${version}/${desktop[1]}`;
      } else if (pointer.status !== 404) throw new Error('Unavailable release pointer');

    }
  } catch {
    return new Response('Download upstream unavailable\n', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
  const url = new URL(`${ORIGIN}${objectPath}`);
  // Channel objects are replaced by publication. Bypass Cloudflare's cache
  // so a release proof sees the current channel immediately.
  url.searchParams.set('channel_check', String(Date.now()));
  const headers = new Headers({ 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' });
  for (const name of ['range', 'if-range']) {
    if (request.headers.has(name)) headers.set(name, request.headers.get(name));
  }
  let upstream;
  try {
    upstream = await fetchImpl(url.href, { method: request.method, headers, redirect: 'follow', cache: 'no-store' });
  } catch {
    return new Response('Download upstream unavailable\n', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
  const outgoing = new Headers();
  for (const name of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    if (upstream.headers.has(name)) outgoing.set(name, upstream.headers.get(name));
  }
  outgoing.set('Cache-Control', 'no-store');
  outgoing.set('Access-Control-Allow-Origin', '*');
  outgoing.set('X-Content-Type-Options', 'nosniff');
  outgoing.set('X-Beeline-Downloads', 'r2');
  const file = helper?.[2];
  outgoing.set('Content-Type', file === 'manifest.json' ? 'application/json; charset=utf-8'
    : file?.endsWith('.sha256') ? 'text/plain; charset=utf-8'
    : file?.endsWith('.mjs') ? 'text/javascript; charset=utf-8'
    : file ? 'application/gzip' : upstream.headers.get('content-type') ?? 'application/octet-stream');
  if (upstream.headers.has('content-disposition')) outgoing.set('Content-Disposition', upstream.headers.get('content-disposition'));
  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: outgoing });
}

export default { fetch: request => serveDownloads(request) };
