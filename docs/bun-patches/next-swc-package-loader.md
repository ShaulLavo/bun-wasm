# Next SWC package loader

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| Next `packages/next/src/build/swc/index.ts`, distributed as `next/dist/build/swc/index.js` | Upstream bug | Resolve installed SWC WASM packages before converting their entry paths to file URLs. |
| `crates/bunwasm-runtime/src/next_swc.rs` and the `modules.rs` source-loading hook | Host feature | Original, package-scoped adapter applied before normal parsing and import scanning. |
| `scripts/next-swc-loader.test.ts` and `checks/runtime-next-swc-loader.json` | Host feature | Original tests of the production adapter, registered in the runtime check manifest. |

## Upstream source

The matched import expression comes from Next 15.5.6, published in
`next-15.5.6.tgz`. The distributed loader has SHA-256
`7feb0d1ee31eea0960ea195f9d11917e6941ed8edc578576bbc3086e96f46476`.
Its `loadWasmRawBindings` helper passes the bare names
`@next/swc-wasm-nodejs` and `@next/swc-wasm-web` to `pathToFileURL`.
That API resolves filesystem paths, not installed packages. The local-package
failure is swallowed and Next then attempts its download fallback.

## Local change

The adapter applies only to `node_modules/next/dist/build/swc/index.js` with
one matching import expression and the expected helper name. It uses the
module's ordinary `require.resolve` before file-URL conversion when no download
path was supplied. Explicit download paths stay unchanged. Other modules and
general file-URL semantics stay unchanged. The loader still parses the adapted
source and scans its imports through the normal transpiler.

The Rust adapter is original bun-wasm code. Its two expression strings match
and replace the identified upstream code. No compiler implementation, native
binding, package-manager stub, or alternate OS implementation is added.

## Verification limits

Six Rust controls cover the installed-package rewrite, nested installations,
other files, changed loader shapes, ambiguous input, and repeated application.
The source check compiles this production adapter without building a guest.

A separate frozen-package control runs the exact upstream helper after applying
this adapter. The official `@next/swc-wasm-nodejs@15.5.6` backend parses typed
input, emits executable JavaScript, and rejects invalid syntax. Both an installed
package and an explicit download directory work. This establishes the loader
correction, not a Next application or published-runtime pass.

The fixture must still provide the official compiler backend. Interpreter
reference-value and table support are separate from package resolution. This
change does not implement either capability or change Waffle.

[Ledger scope and pinned revisions](scope.md).
