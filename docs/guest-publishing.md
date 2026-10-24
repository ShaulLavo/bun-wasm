# Bun guest artifact publishing

The package's matching `bun.wasm` guest is published as an immutable, hash-addressed R2 object. The public descriptor is generated only after an upload is read back through the custom domain and verified.

## Durable Cloudflare resources

These resources are intentionally retained for future matching guests:

- R2 bucket: `bun-wasm-guests` (standard storage class).
- R2 custom domain: `bun-artifacts.shaulavo.dev`, zone `shaulavo.dev`, minimum TLS 1.2, public access enabled.
- R2 CORS policy: origins `*`; methods `GET`, `HEAD`; exposed header `ETag`; max age 3600 seconds.

The custom domain was selected after checking Cloudflare DNS, Worker custom domains/routes, and Mesh routes. It had no existing claim. Do not delete the bucket or domain when cleaning up a publication test: they are the durable guest artifact store. Individual test objects must be removed.

## One-time bucket and domain setup

The setup above is already live; normal publishing does **not** repeat it. For recreation, first inspect `cf r2 buckets list`, exact DNS records, account Worker custom domains, zone Worker routes, and `mesh serve ls`. Preserve all unrelated records, Mesh-owned names, and the private wildcard. The hostname must remain dedicated to this public artifact store.

Install the site's pinned Wrangler with `bun install --cwd site --frozen-lockfile`, refresh the existing login with `cf auth whoami >/dev/null`, and create the bucket only if it is absent. This is infrastructure setup only; publishing also requires the [browser dependencies below](#commands).

```sh
CLOUDFLARE_API_TOKEN="$(python3 -c "import json; print(json.load(open('$HOME/.config/cloudflare/config/default.json'))['oauth_token'])")" \
  bun site/node_modules/wrangler/bin/wrangler.js r2 bucket create bun-wasm-guests
```

Find the `shaulavo.dev` zone ID with `cf zones list --name shaulavo.dev`. Then attach the R2 custom domain and set this dedicated bucket's CORS policy (use `--dry-run` first):

```sh
cf r2 buckets domains custom create bun-wasm-guests \
  --domain bun-artifacts.shaulavo.dev --enabled --min-tls 1.2 --zone-id <shaulavo-zone-id>
cf r2 buckets cors update bun-wasm-guests --force \
  --rules '[{"allowed":{"origins":["*"],"methods":["GET","HEAD"]},"exposeHeaders":["ETag"],"maxAgeSeconds":3600}]'
cf r2 buckets domains custom list --bucket-name bun-wasm-guests
cf r2 buckets cors get bun-wasm-guests
cf r2 buckets domains managed list --bucket-name bun-wasm-guests
```

Wait for ownership and SSL to report `active` before publishing. Cloudflare manages the exact proxied CNAME to `public.r2.dev` and its certificate; do not create a CNAME to the rate-limited `r2.dev` development URL. The managed `r2.dev` domain stays disabled. No Worker, upload service, or Cache Rule is needed: `.gz` objects are cache-eligible, and immutable caching is set in each object's metadata.

## Object and descriptor contract

For decompressed WASM bytes `W`:

- `sha256 = SHA-256(W)` as lowercase hexadecimal.
- `bytes = W.byteLength`.
- object key: `<sha256>/bun.wasm.gz`.
- object URL: `https://bun-artifacts.shaulavo.dev/<sha256>/bun.wasm.gz`.
- object metadata: `Content-Type: application/wasm`, `Content-Encoding: gzip`, and `Cache-Control: public, max-age=31536000, immutable, no-transform`.
- descriptor: `{ "url": ..., "sha256": ..., "bytes": ... }`.

Raw and gzip input are accepted. The publisher always hashes decompressed bytes, creates a deterministic gzip upload, and never publishes a descriptor for an incompatible guest. The key is content-addressed, so concurrent valid publishers upload identical bytes. Before uploading, an existing object is read and must match the descriptor; a mismatched object is an error and is never overwritten. After uploading, the object is fetched from the public domain with an `Origin` header and checked for hash, size, status, content headers, immutable cache directives, and `Access-Control-Allow-Origin: *`.

## Commands

Run from this package checkout with Bun installed. A fresh checkout needs the root package dependencies, the site's lockfile-pinned Wrangler **4.151.0**, the web development dependencies (including Playwright), and all three browser executables:

```sh
source env.sh
export PLAYWRIGHT_BROWSERS_PATH=/work/cache/ms-playwright
bun install --frozen-lockfile
bun install --cwd site --frozen-lockfile
bun install --cwd web --frozen-lockfile
(cd web && bunx --no-install playwright install chromium firefox webkit)
```

On other machines, set `PLAYWRIGHT_BROWSERS_PATH` to a writable data/cache directory and retain that same value when publishing. The browser install uses the web lockfile's exact Playwright version, not a newly downloaded CLI. Linux also needs Playwright's system libraries; provision them through the host's normal package workflow if browser launch reports a missing shared library. Installation alone does not create the three guest builds: build the [matching engines](browser-package.md#required-full-build-interruption-acceptance) before publishing. For a PC publication, use the shared heavy runner as described there.

Refresh only the existing authenticated Cloudflare session when ready to publish:

```sh
cf auth whoami >/dev/null
```

`CLOUDFLARE_API_TOKEN` is read only from the environment and is never printed or stored. Set `CLOUDFLARE_ACCOUNT_ID` to the bucket's account ID; obtain it from the selected Cloudflare account or the authenticated CLI. Do not run a new login or create a credential as part of publishing.

Generate a descriptor without publishing:

```sh
bun scripts/guest-artifact.ts /path/to/bun.wasm --output src/guest-asset.generated.ts
```

Publish a matching guest and generate its descriptor after verification:

```sh
CLOUDFLARE_ACCOUNT_ID=<account-id> \
CLOUDFLARE_API_TOKEN="$(python3 -c "import json; print(json.load(open('$HOME/.config/cloudflare/config/default.json'))['oauth_token'])")" \
bun scripts/publish-guest.ts /path/to/bun.wasm --output src/guest-asset.generated.ts
```

Publication first snapshots all three matching real engine builds from `dist/` (or `--dist`) into a private, read-only directory. The requested upload must match a snapshot artifact. The [required full-build interruption matrix](browser-package.md#required-full-build-interruption-acceptance) fetches only that snapshot in Chromium, Firefox and WebKit. Each browser records the SHA-256 and byte count of the exact buffers it compiles; all receipts must match the snapshot manifest. The upload is then prepared from those verified snapshot bytes, never by rereading the live build directory. Concurrent rebuilds cannot replace the tested guest. Missing builds, failed proofs, mismatched receipts and unsafe cleanup prevent storage access and descriptor changes.

The publisher uses the site's lockfile-pinned Wrangler for the upload. It creates only a temporary `bun-wasm-guest-publish-*` directory (under `TMPDIR` when set, otherwise `/work/tmp` when available, otherwise the OS temporary directory). Success, failure, and interruption stop the upload child before removing that directory. It does not create a Worker or permanent upload service.

`src/guest-asset.generated.ts` records the last verified publication; update it only after the matching full-build acceptance and public read-back succeed.

The current default browser guest is the one named in `src/guest-asset.generated.ts`.
Its source inputs live in the `.build.json` receipt that `scripts/guest-build-receipt.ts` wrote next to the artifact.

## Verification and disposable tests

```sh
bun test tests/package/guest-artifact.test.ts
bun run check
```

Artifact-free unit tests use small valid WASM fixtures and fake storage. They do not bypass full-build acceptance for live publication. For a live disposable test, use task-owned copies of all three real builds and give the selected guest a unique harmless WASM custom section, preserving its behavior. It must pass the same browser matrix. Write its descriptor to scratch, never to the package's default descriptor. Publish twice to check idempotence, and test an actual browser `fetch()` from a different HTTPS origin: its response must be `cors`, its body must decode to the descriptor's byte count and SHA-256, and the module must validate. Check object metadata and CORS with a separate request carrying an `Origin` header. Never remove a real published guest as test cleanup.

Install fixture teardown before uploading. After stopping all fixture consumers, remove only its exact R2 key with the site's pinned `wrangler r2 object delete <bucket>/<sha256>/bun.wasm.gz --remote`. Immutable CDN entries survive an origin deletion, so also purge only that fixture URL (including its tested Origin cache-key variant) from the `shaulavo.dev` zone's cache. Confirm authenticated R2 GET **and** public GET both return 404. Remove local fixture files, temporary browser profiles, and test scratch, leaving the durable bucket/domain and real published guests intact.
