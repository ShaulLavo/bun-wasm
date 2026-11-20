# Rolldown memory allocation

## Classification

| Source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/rolldown_memory.rs` and its call in `modules.rs` | Host feature | Original adapter for two byte-identified published Rolldown loaders. |
| `scripts/rolldown-memory.test.ts`, `scripts/rolldown-memory-browser.ts`, and `scripts/fixtures/rolldown-memory-{adapter.rs,probe.ts}` | Host feature | Original real-package controls for the compiled adapter. |

## Upstream identities

The MIT-licensed npm package `@rolldown/binding-wasm32-wasi@1.2.16`
comes from <https://github.com/rolldown/rolldown>, directory `packages/rolldown`.
The published tarball identifies the inspected revision. No upstream source or
binary is checked in, and the adapter does not modify installed package files.

| File | SHA-256 |
| --- | --- |
| Published tarball | `003f64a43c6e77a24228c02538a89c87ded2cb375ea3c091d82b19d9e8aae17b` |
| `rolldown-binding.wasi.cjs` | `01fd76391144044f32cb53d6de240fb6abe85a98180517db78c010e514303612` |
| `rolldown-binding.wasi-browser.js` | `169928275e38b417fd87baacd822509abcc0a547893c4f7b59524d17d65e7635` |
| `rolldown-binding.wasm32-wasi.wasm` | `006b1889047c7e437732104a61d92f15967516a84d7bc738f043e870ac5d0679` |

## Layout and change

Both loaders request 16,384 initial pages, or 1,073,741,824 bytes. The real
binary imports `env.memory` with a minimum of 1,001 pages, a maximum of 65,536,
and the shared flag. Its stack pointer starts at 64,000,000 bytes. Its start
function initializes passive data and zeroed storage through byte 65,584,755.
The imported minimum provides 65,601,536 bytes. A real engine rejects 1,000
pages before any imported function runs.

The adapter supplies 1,001 initial pages and a 32,768-page maximum on desktop
and grouped engines. The iPhone Browser executor supplies the internal
`BUN_WASM_IPHONE_NATIVE_MEMORY` fact, selecting a 4,096-page maximum, 256 MiB,
for its independent native tool memory. The executor removes that fact when
selecting another engine. Nested shared tools in grouped engines use regions
of their existing backing, so they keep their original logical maximum and
region-allocation behavior. The imported maximum is an upper bound on
the supplied memory, not a requirement to reserve 4 GiB. The real binary, shared
flag, stack, worker pools, thread imports, and exports remain unchanged. Equal-width replacement preserves source positions. This saves
1,008,140,288 bytes of initial logical capacity. It also avoids asking Safari to admit a 4 GiB shared maximum. Neither declared
capacity measures physical memory.

WebKit reserves a native shared memory's declared maximum on iPhone. The
256 MiB bound leaves 152,502,272 bytes above the 115,933,184-byte capacity
reached by the published-package API controls in Chromium and Linux WebKit.
A separate real Vite 8.3.5 and React production build with the same adapted
Wasm binding reaches 99,155,968 bytes under Node. These measurements cover
these workloads; larger projects may exhaust the iPhone limit.

Only the exact loader path and matching loader/binary hashes qualify. Changed
or missing binaries, changed loaders, swapped loader types, unrelated paths,
and the presence of the debug binary leave the source borrowed and unchanged.
Binary hashing streams through `std::io::copy`; it does not copy the whole
binary. A successful adaptation allocates only the replacement loader string.

Module preparation runs the adapter before transpilation. `depends_on_binary`
excludes both paths from prepared-source reuse, while preserving the Oxc
exclusion. They requalify on every load, including when the JavaScript is
unchanged or disappears. A cached reduction cannot survive a changed or missing
binary or a newly selected debug binary. The integrated Rust cache regression
exercises these external changes after warming both loader paths.

## Controls and limits

`checks/runtime-rolldown-memory.json` uses the existing runtime check owner.
`bun test scripts/rolldown-memory.test.ts` downloads the immutable package,
compiles only this adapter, checks qualification, and compares real Node
synchronous and asynchronous parsing, transformation, minification, bundling,
caller errors, and disposal. It also checks an 8,000-statement input and the
binary minimum.
The Node fixture receives the acquired package root and resolves its declared
name from that scope, preserving conditional exports without a root dependency.

Set `BUNWASM_ROLLDOWN_BROWSER_RESULT` to an output JSON path to run the browser
controls from the same test setup. Use the shared runner's browser class for
that explicit run. The default runtime gate keeps these browser controls skipped.

`scripts/rolldown-memory-browser.ts` takes an isolated dependency tree, the
compiled adapter, and an output JSON path. It bundles the stock and compiled
adapter output of the published browser loader, then exercises real APIs in
isolated Chromium and WebKit workers. Observation stays lexical to the test
bundle. It does not replace the global memory constructor. Every browser arm,
including failures, is retained in its output. Browser contexts, the private
listener, generated bundles, and profiles are removed in teardown.

In the bounded Linux controls, Node 26.12.1, Chromium 156.0.8078.4, and WebKit
27.2 pass both variants. Reduced capacity grows to 82,378,752 bytes during
initialization and 115,933,184 bytes during API operations. Stock capacity
remains 1,073,741,824 bytes. These are logical capacities, not RSS or peaks.

A native iPhone Safari control localized the earlier failure to the shared
`WebAssembly.Memory` constructor before binary loading. Its 1,001-page initial
allocation was rejected with a 65,536-page maximum and admitted with a
32,768-page maximum. The latter still covers the complete static layout and
permits growth beyond the real sync, async and bundling controls. The declared
4 GiB maximum is unnecessary for these operations. The package version and
hashes above still match the installed Vite 8.3.5 dependency. No threading
policy or fallback path changes accompany this adaptation.

The Rolldown and Oxc warmed-source cache regressions use the existing
`modules::tests::host_` group selected by the native quality gate. Both remain
ordinary module tests as well; no workflow filter or test assertion changes.

[Ledger scope and pinned revisions](scope.md).
