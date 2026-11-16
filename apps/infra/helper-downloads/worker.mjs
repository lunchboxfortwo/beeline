// Keep installed helpers' /dl URLs stable while streaming public R2 objects.
// No download credentials, Pages deployment or archive buffering needed.
export async function serveDownloads(request, fetchImpl = fetch) {
  const path = new URL(request.url).pathname;
  const match = /^\/dl\/(next\/)?(manifest\.json|beeline-bootstrap\.mjs(?:\.sha256)?|beeline-(?:linux-x64|darwin-arm64|darwin-x64)\.tar\.gz(?:\.sha256)?)$/.exec(path);
  if (!match) return new Response('Download not found\n', { status: 404 });
  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response('Method not allowed\n', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const url = new URL(`https://downloads.usebeeline.app/dl/${match[1] ? 'next/' : ''}${match[2]}`);
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
  outgoing.set('Content-Type', match[2] === 'manifest.json' ? 'application/json; charset=utf-8'
    : match[2].endsWith('.sha256') ? 'text/plain; charset=utf-8'
    : match[2].endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'application/gzip');
  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: outgoing });
}

export default { fetch: request => serveDownloads(request) };
