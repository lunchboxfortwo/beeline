# Helper downloads

`worker.mjs` streams helper and desktop downloads from public R2 objects.
`/dl/next/*` serves the candidate helper channel. `/dl/*` and
`downloads.usebeeline.app/latest/*` resolve `latest-release.json` in
`beeline-downloads` to the same immutable rc, with the legacy R2 paths used
until the first pointer is present. Helper filenames and desktop updater URLs
stay stable. The website also uses the desktop routes in its installer links.

GET and HEAD preserve ranges without forwarding caller credentials. The
Worker bypasses caches for channel pointers and streams payloads directly.
The release pipeline writes the pointer after staging all referenced artifacts.

## Rollout

Activate both routes before the first promotion using this workflow. Merging the
code does not configure Cloudflare. Do not dispatch a release for this setup.

1. Run `node --test packages/scripts/helper-downloads.test.mjs` and
   `npm run test:deploy`. The helper action dry run executes its real
   publication script against mocked R2 and GitHub uploads, reads those bytes through
   the Worker, and proves the website artifact has no `dl` directory.
2. With account Workers Scripts Edit and zone Workers Routes Edit permissions,
   deploy a preview without registering a route:
   `npx wrangler deploy --config apps/infra/helper-downloads/wrangler.jsonc --env preview`.
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
   `npx wrangler deploy --config apps/infra/helper-downloads/wrangler.jsonc`.
   The existing proxied apex DNS record remains unchanged. Verify both
   canonical helper manifests, sidecars, bootstrap, GET/HEAD and the squire
   read-only check again. Verify that the desktop updater manifest under
   `downloads.usebeeline.app/latest/` serves the current version and carries
   `X-Beeline-Release-Pointer: 1`. Check `/install`, `/install.sh`, `/` and app associations still
   resolve through the existing static site.

To roll back the download channels, restore the preceding pointer to its
immutable candidate. Keep both public rolling releases for helper recovery.
An interrupted upload fails checksum validation and a release rerun repairs
it; installed helpers remain on their verified release.

Cloudflare references: [route configuration](https://developers.cloudflare.com/workers/configuration/routing/routes/),
[fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/).
