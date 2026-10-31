# Next SWC package loader

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| Next `packages/next/src/build/swc/index.ts`, distributed as `next/dist/build/swc/index.js` | Upstream bug | Resolve installed SWC WASM packages before converting their entry paths to file URLs. |
| Next 14.2.33 `packages/next/src/build/swc/index.ts` fallback-platform calculation | Port | Make `wasm32` eligible for the existing opt-in WASM-first path. |
| `crates/bunwasm-runtime/src/next_swc.rs` and the `modules.rs` source-loading hook | Host feature | Original, package-scoped adapter applied before normal parsing and import scanning. |
| `scripts/app-matrix/product-next.ts` and `product-next.test.ts` | Host feature | Declare the exact official Next 14 compiler and opt into it through supported Next configuration. |
| `scripts/next-swc-loader.test.ts` and `checks/runtime-next-swc-loader.json` | Host feature | Original tests of the production adapter, registered in the runtime check manifest. |

## Upstream source

The matched import expression occurs in Next 15.5.6 and 14.2.33, published in
`next-15.5.6.tgz` and `next-14.2.33.tgz`. The distributed loaders have SHA-256
`7feb0d1ee31eea0960ea195f9d11917e6941ed8edc578576bbc3086e96f46476`
and `7c5b014baab7b74a05d2324d6205ffdea760f612f57133566c3aad28ce8da1fa`.
Next 15.5.6 uses `loadWasmRawBindings`; Next 14.2.33 uses `loadWasm`.
Both pass the bare names `@next/swc-wasm-nodejs` and `@next/swc-wasm-web` to
`pathToFileURL`. That API resolves filesystem paths, not installed packages.
The local-package failure is swallowed and Next then attempts its download
fallback.

Next 14.2.33 also derives WASM-first eligibility only from its native fallback
triple table. That table has no `wasm32` entry, so the supported
`experimental.useWasmBinary` option is ignored on `linux/wasm32`.

## Local change

The adapter applies only to `node_modules/next/dist/build/swc/index.js` with
one matching import expression and an expected helper name. It uses the
module's ordinary `require.resolve` before file-URL conversion when no download
path was supplied. Explicit download paths stay unchanged.

The Next 14 adaptation additionally requires the exact
`const nextVersion = "14.2.33";` source marker and one exact fallback-platform
expression. It adds `wasm32` to that eligibility calculation. The existing
option still controls WASM-first selection, and `NEXT_DISABLE_SWC_WASM` retains
its behavior. Other Next versions, modules, and general file-URL semantics stay
unchanged. The loader still parses the adapted source and scans its imports
through the normal transpiler.

The Next 14 fixtures explicitly depend on
`@next/swc-wasm-nodejs@14.2.33` and set `experimental.useWasmBinary: true`.
Static fixtures retain `output: "export"`; dynamic fixtures retain their routes
and probes. Next 15 and 16 fixture configuration is unchanged.

The Rust adapter is original bun-wasm code. Its expression strings match and
replace the identified upstream code. No compiler implementation, native
binding, package-manager stub, or alternate OS implementation is added.

## Verification limits

Nine Rust controls cover both installed-package rewrites, Next 14 fallback
selection, exact source-version qualification, nested installations, other
files, changed loader shapes, ambiguous input, and repeated application. The
source check compiles this production adapter without building a guest.

A native Bun control runs the full published Next 14.2.33 loader with the
official `@next/swc-wasm-nodejs@14.2.33` package. The raw official backend
transforms and executes typed input before and after adaptation. The original
`loadWasm` rejects with that package installed. The original
`loadBindings(true)` ignores the option and exits with native-load failure.
The production adapter makes both entry points return the official WASM
compiler and execute its output without invoking the downloader. This is a
native source and compiler control, not a Next application or guest pass.

Interpreter reference-value and table support are separate from package
resolution. This change does not implement either capability or change Waffle.

[Ledger scope and pinned revisions](scope.md).
