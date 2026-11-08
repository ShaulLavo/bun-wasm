# CI release downloads

Class **Host feature**. These are original CI and test adapters, not copied
upstream implementations.

`scripts/ci-release-download.ts` resolves a public GitHub release URL to its
release-asset API endpoint using the job's ephemeral token. It caches bytes under
the SHA-256 of the complete original URL, never the token or temporary signed URL.
Retries are limited to three HTTP attempts with one- and two-second backoff.
Redirects are bounded and restricted to GitHub's API and asset hosts. Authorization
is sent only to the API. CMake, Ninja, Binaryen, SDK, Wasmtime and wasm-tools keep
their existing archive checksums and version checks.

The sccache adapter replaces acquisition in mozilla-actions/sccache-action
`src/setup.ts` at `d651010b8da762cde178750d8eda7b5febfe147a`. That action's pinned
version path uses unauthenticated `downloadTool` calls even when its default token
input is present. The local adapter keeps v0.19.0, its published SHA-256 validation
and a version check. The existing private cache-server wrapper owns shutdown.

`scripts/ci-stage-release-packages.ts` feeds the intentionally cold consumer test
through Bun's supported local-tarball overrides. Each archive first matches the
SHA-512 integrity from the unchanged source lockfile. Only the temporary fixture
manifest gets overrides. A separate resolution cache prepares its temporary
lockfile; non-release package resolutions must remain identical. The actual
install still uses an empty Bun cache and the same frozen-install deadline, then
runs every existing export, preparation and dependency-resolution assertion.
This does not authenticate Bun's own remote-tarball requests. Non-release Git
inputs retain their original transport.

The existing Ubuntu quality job publishes its completed normal Bun cache before
consumer jobs start. Its key hashes every frozen lockfile, including exact URLs
and integrities. Boat consumers restore this supported cache rather than relying
on a first unauthenticated release download from their address.
