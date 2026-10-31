# Next SWC compiler selection

## Classification

| Source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/install/resolve/next_swc.rs` | Host feature | Original adapter that adds Next's official WASM compiler to resolved package metadata. |
| `install/resolve.rs` package and lock metadata boundaries | Host feature | Apply the adapter before ordinary dependency traversal. |
| `install/resolve/next_swc_tests.rs` and `next16_swc_tests.rs` | Host feature | Original dependency graph, platform, optional dependency, missing-backend, and lock controls. |
| `scripts/app-matrix/product-next.ts` Next 16 commands | Host feature | Original fixtures select the official Webpack CLI path for the WASM backend. |

## Upstream package

Next 15.5.6 and 16.4.3 declare native SWC packages as optional dependencies but do
not include either WASM compiler in their dependency graphs. Their
`packages/next/src/build/swc/index.ts`, distributed as `dist/build/swc/index.js`
in the exact `next-15.5.6.tgz` and `next-16.4.3.tgz` releases, supports
`@next/swc-wasm-nodejs` as a fallback. The Node backend at each matching version has
`wasm.js` as its entry and ships the real compiler in `wasm_bg.wasm`.

Without an installed backend, Next's downloader asks npm for the registry.
The browser guest does not provide npm. Installing the supported compiler through
the normal package graph avoids that downloader requirement.

## Local change

The adapter applies only to resolved `next` version 15 or 16 metadata whose native
optional SWC entries all match that exact version. It adds
`@next/swc-wasm-nodejs` at the same exact version as a dependency. It does not
change an existing declaration of that backend, including an optional one.
Other packages and Next major versions remain unchanged. Next 14 has a different
WASM fallback-selection and package-import path and is not qualified by this rule.

Both registry selection and locked package reconstruction apply the adapter.
The ordinary resolver handles placement, tarball integrity, caching, optional
parent propagation, and lock output. Native optional dependencies remain in
metadata and retain their existing platform filtering. The application manifest,
registry implementation, package-manager commands, and advertised guest platform
are unchanged.

This is original bun-wasm code, not a copied compiler or an upstream patch.
The installed-package loader correction is separate, recorded in
[next-swc-package-loader.md](next-swc-package-loader.md).

## Next 16 bundler selection

Next 16.4.3 defaults to Turbopack in `packages/next/src/lib/bundler.ts`,
distributed as `dist/lib/bundler.js`. Its official WASM wrapper rejects
`turbo.createProject` because native `projectNew` is unavailable and explicitly
requests `--webpack`. The CLI in `packages/next/src/bin/next.ts`, distributed as
`dist/bin/next`, exposes that flag for both dev and build. All five Next 16
catalog cases select it for those two commands. Start and static preview remain
unchanged. Every Next 14 and 15 command, dependency, and feature assertion is
unchanged too.
No backend is added directly to a fixture, and no Turbopack capability is faked.

## Verification

Private helper tests cover exact version selection, metadata preservation,
qualification, declared backends, and idempotence. Resolver tests cover unlocked
and old-lock installs, native package exclusions, optional Next, a conflicting
root backend version, and lock replay without registry metadata for both Next
majors. Next 16 also
checks that a missing exact backend fails a required install instead of silently
skipping it. The existing RAW packument residency controls remain unchanged.

These Rust tests belong to the existing `quality:rust` Cargo test owner. They do
not add a script or native fixture, so no additional check manifest or duplicated
CI command is needed.

A frozen Next 15.5.6 package control executes the production metadata helper and
checks that only the compiler dependency changes. This is a source-level control,
not a Next build pass. A Next 16.4.3 native package control verifies the official
backend transforms typed source and that the real Next WASM wrapper rejects
Turbopack. Catalog controls verify exact commands for all three majors.
Acceptance still requires the fixtures to run in a source-qualified guest with
the matching official backend. Cache Components/PPR verification stays pending;
selecting Webpack does not establish that feature works. This adapter does
not change engine WebAssembly support or Waffle.

[Ledger scope and pinned revisions](scope.md).
