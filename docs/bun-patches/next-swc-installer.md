# Next SWC compiler selection

## Classification

| Source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/install/resolve/next_swc.rs` | Host feature | Original adapter that adds Next's official WASM compiler to resolved package metadata. |
| `install/resolve.rs` package and lock metadata boundaries | Host feature | Apply the adapter before ordinary dependency traversal. |
| `install/resolve/next_swc_tests.rs` | Host feature | Original dependency graph, platform, optional dependency, and lock controls. |

## Upstream package

Next 15.5.6 declares native SWC packages as optional dependencies but does not
include either WASM compiler in its dependency graph. Its
`packages/next/src/build/swc/index.ts`, distributed in `next-15.5.6.tgz`, supports
`@next/swc-wasm-nodejs` as a fallback. The Node backend at version 15.5.6 has
`wasm.js` as its entry and ships the real compiler in `wasm_bg.wasm`.

Without an installed backend, Next's downloader asks npm for the registry.
The browser guest does not provide npm. Installing the supported compiler through
the normal package graph avoids that downloader requirement.

## Local change

The adapter applies only to resolved `next` version 15 metadata whose native
optional SWC entries all match that exact version. It adds
`@next/swc-wasm-nodejs` at the same exact version as a dependency. It does not
change an existing declaration of that backend, including an optional one.
Other packages and Next major versions remain unchanged.

Both registry selection and locked package reconstruction apply the adapter.
The ordinary resolver handles placement, tarball integrity, caching, optional
parent propagation, and lock output. Native optional dependencies remain in
metadata and retain their existing platform filtering. The application manifest,
registry implementation, package-manager commands, and advertised guest platform
are unchanged.

This is original bun-wasm code, not a copied compiler or an upstream patch.
The installed-package loader correction is separate, recorded in
[next-swc-package-loader.md](next-swc-package-loader.md).

## Verification

Private helper tests cover exact version selection, metadata preservation,
qualification, declared backends, and idempotence. Resolver tests cover unlocked
and old-lock installs, native package exclusions, optional Next, a conflicting
root backend version, and lock replay without registry metadata.

These Rust tests belong to the existing `quality:rust` Cargo test owner. They do
not add a script or native fixture, so no additional check manifest or duplicated
CI command is needed.

A frozen Next 15.5.6 package control executes the production metadata helper and
checks that only the compiler dependency changes. This is a source-level control,
not a Next build pass. Acceptance still requires the unchanged Next build fixture
to run in a source-qualified guest with the official backend. This adapter does
not change engine WebAssembly support or Waffle.

[Ledger scope and pinned revisions](scope.md).
