# Helper downloads

`worker.mjs` serves `usebeeline.app/dl/*` from public R2 objects at
`https://downloads.usebeeline.app/dl/...`. Latest uses the `dl/` prefix in
`beeline-downloads`; next uses `dl/next/`. The rolling GitHub Releases
`helper-update-channel` and `helper-update-channel-next` retain secondary copies.
Archive names, checksums and recovery bootstrap paths stay unchanged. `/install` and
`/install.sh` stay on the static website and already fetch these `/dl` paths.
Desktop installers and application updates use the same R2 bucket under
versioned and `latest/` prefixes.

GET and HEAD stream bytes without buffering archives or forwarding caller
credentials. Range requests remain range requests. Clients see no redirect.
Mutable channel responses and upstream failures are not cached; a cache-busting
query makes the next verification read the freshly published bytes. Publication
uses `CLOUDFLARE_R2_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through the shared desktop
R2 client. Downloads need no credentials or additional release gate.

The helper action validates, uploads and verifies the public channel directly.
Pages receives only the static marketing site and associations. Next helper
publication does not deploy the website. Latest publication runs the website
leg when selected, independently of helper publication.

## Rollout

Activate the route before the first release using this workflow. Merging the
code does not configure Cloudflare. Do not dispatch a release for this setup.

1. Run `node --test scripts/helper-downloads.test.mjs` and
   `npm run test:deploy`. The helper action dry run executes its real
   publication script against mocked R2 and GitHub uploads, reads those bytes through
   the Worker, and proves the website artifact has no `dl` directory.
2. With account Workers Scripts Edit and zone Workers Routes Edit permissions,
   deploy a preview without registering a route:
   `npx wrangler deploy --config infra/helper-downloads/wrangler.jsonc --env preview`.
   Alternatively use `wrangler dev` for a local preview. Do not overwrite an
   existing Worker belonging to another service.
3. Compare `/dl/manifest.json` and `/dl/next/manifest.json` from the preview
   with the current public manifests. Fetch every referenced archive and
   bootstrap; check its byte count, SHA-256 and sidecar. The response must carry
   `X-Beeline-Downloads: r2` and have no client redirect. If the
   rolling assets name a release that never finished, stop before routing:
   firstmate must repair/select the intended channel, without releasing it here.
4. On squire, copy only `BEELINE_RELEASE_CHANNEL` and
   `BEELINE_UPDATE_MANIFEST_URL` from the serving helper's process environment.
   Run the installed helper's `update --check` against the preview manifest
   with the same `/dl/next/manifest.json` path. This command only reads the
   install and manifest. Do not run `update` without `--check`, start, restart,
   or change the production service environment.
5. Deploy the reviewed route with
   `npx wrangler deploy --config infra/helper-downloads/wrangler.jsonc`.
   The existing proxied apex DNS record remains unchanged. Verify both
   canonical manifests, sidecars, bootstrap, GET/HEAD and the squire read-only
   check again. Check `/install`, `/install.sh`, `/` and app associations still
   resolve through the existing static site.

Removing only this Worker's `/dl/*` route restores the old Pages download
snapshot. It does not undo a helper channel publication; check the snapshot's
identity before considering it a rollback. Keep both public rolling releases.
An interrupted upload fails checksum validation and a release rerun repairs
it; installed helpers remain on their verified release.

Cloudflare references: [route configuration](https://developers.cloudflare.com/workers/configuration/routing/routes/),
[fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/).
