# CI release downloads

Class **Host feature**. These are original CI and test adapters, not copied
upstream implementations.

`scripts/ci-release-download.ts` resolves a public GitHub release URL to its
release-asset API endpoint using the job's ephemeral token. It caches bytes under
the SHA-256 of the complete original URL, never the token or temporary signed URL.
Retries are limited to three HTTP attempts with one- and two-second backoff.
Redirects are bounded and restricted to GitHub's API and asset hosts. Authorization
is sent only to the API. Cold CI requests fail without a token rather than falling
back to public downloads. Cached bytes remain usable without a token. Node and Bun
execute the same transport. CMake, Ninja, Binaryen, SDK, Wasmtime and wasm-tools keep
their existing archive checksums and version checks. ICU 78.3 now uses this transport
before its unchanged SHA-256 check in `jsc/build-icu.sh`.

The sccache adapter replaces acquisition in mozilla-actions/sccache-action
`src/setup.ts` at `d651010b8da762cde178750d8eda7b5febfe147a`. That action's pinned
version path uses unauthenticated `downloadTool` calls even when its default token
input is present. The local adapter keeps v0.19.0, its published SHA-256 validation
and a version check. The existing private cache-server wrapper owns shutdown.

## Frozen consumer installs

Bun 1.4.4 ignores package-name overrides for explicit URL dependencies. Authenticating
a staging download therefore did not stop its resolver from fetching the same public
URL again. This affected direct and transitive dependencies, including scoped packages.

`scripts/ci-stage-release-packages.ts` checks each original archive against the
unchanged source lock's SHA-512. It rebinds release URL strings in a temporary manifest
and lock to those exact local archives. Reverse translation must reproduce the whole
original lock, including non-release packages, metadata and integrities. It does not
repack product archives, resolve new versions or seed Bun's cache through private APIs.

`scripts/ci-install.ts` wraps every ordinary blocking CI install. It restores the exact
original manifest and lock on success or failure. Existing install flags and lifecycle
choices remain. The clean consumer fixture uses the same rebinding, starts with no
installed dependencies and an empty cache, retains its frozen-install deadline, and
runs every original export and preparation assertion. A focused nested fixture also
installs with `--offline`, so no public release request can make that proof pass.

## Updating release pins

`scripts/ci-update-lock.ts` owns the updater's existing lock-only, scripts-disabled
resolution. It follows release dependency metadata and pinned Git source archives,
authenticates release archives, and verifies unchanged pins against their old integrity.
Temporary metadata-only tarballs let Bun resolve newly selected dependencies without
public release requests. They are resolver inputs only, never installed product archives.

The output lock restores canonical published URLs and SHA-512s of the original release
bytes. Pinned Git archives use GitHub's legacy source archive, retaining the original
archive digest, resolved commit and archive-directory identity that Bun records. Git
metadata also enters the temporary solver, so its new release transitives cannot
escape staging. The product manifest is restored exactly. Temporary metadata archives, manifests
and downloads are removed. The regression resolves new direct and scoped transitive pins
with all network access disabled, then installs the resulting canonical lock through
frozen staging. That second install checks the original bytes against the restored digest.
A separate offline Git-to-scoped-release fixture checks canonical Git and release identity.
The reached Web host shell helper uses the same frozen installer for all three projects;
its direct-install paths are included in the coverage regression.
The updater's explicit record downloads keep their existing 120-second bound.

## Cache lifetime

The release cache restores before tool bootstrap and saves at job end only if its
URL-addressed file inventory grew. The inventory digest gives a new immutable cache
key after a partial restore gains assets. An unchanged warm inventory never invokes
`actions/cache/save`, so repeated runs do not store duplicate full caches.

The ordinary Bun cache retains its checkout-relative `BUN_INSTALL_CACHE_DIR` and frozen
lock-based keys. It can accelerate registry and Git inputs, but release acquisition no
longer depends on it being warm. Download diagnostics go to stderr so callers retain
machine-readable stdout.
