# Oxc package initial memory

## Classification

| Source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/oxc_memory.rs` and its call in `modules.rs` | Host feature | Original package adapter that reduces the initial capacity of three byte-identified published Oxc loaders. |
| `scripts/oxc-memory.test.ts` and `scripts/fixtures/oxc-memory-{adapter.rs,probe.ts}` | Host feature | Original controls that compile the adapter and exercise the real published Wasm packages. |

## Upstream identities

The upstreams are the MIT-licensed npm packages
`@oxc-parser/binding-wasm32-wasi`, `@oxc-transform/binding-wasm32-wasi`, and
`@oxc-minify/binding-wasm32-wasi`, each at version `0.94.0`.
Their generated package files are `<name>.wasi.cjs` and
`<name>.wasm32-wasi.wasm`. The repository is
<https://github.com/oxc-project/oxc>, under `napi/parser`, `napi/transform`, and
`napi/minify`. The published tarballs are the authoritative revisions here.
No upstream implementation or binary is checked in or modified.

| Package | Published tarball SHA-256 |
| --- | --- |
| Parser | `30e515f96d93dc421b81874403f1f89a6a7bc5eda0983e66a3dd31f4bf292884` |
| Transform | `de3ee7cebc234fcde803c32d916e870d6d5c43514d933e0c98dcb38bb2983c30` |
| Minify | `b75bb32c831cd9517e50440b728ab83f1da1b03e2d3fb06b21b2a1bc052a4cf1` |

The adapter records both loader and binary SHA-256 identities. It applies only
to the matching package path and exact published pair. Changed sources, changed
or missing binaries, and the upstream debug-binary selection keep their original
behavior.

Prepared-source cache hits do not bypass that qualification. These three loader
paths prepare again on reload because their Wasm or debug selection can change
without changing the JavaScript. Unrelated source caches retain their behavior.

## Layout and change

The loaders request 4,000 initial pages. The actual binary imports require 980
pages for parser and 981 pages each for transform and minify. These minima cover
their linked layout, including the stack pointer initialized to 64,000,000 bytes.
One page below each minimum fails the real engine's import check.

| Binary | Imported minimum, pages | End of the last initialized static data range, bytes | Initial capacity, bytes |
| --- | ---: | ---: | ---: |
| Parser | 980 | 64,199,940 | 64,225,280 |
| Transform | 981 | 64,277,036 | 64,290,816 |
| Minify | 981 | 64,242,092 | 64,290,816 |

Rounding each data end up to a Wasm page gives the corresponding imported
minimum. The binaries initialize passive data through `memory.init`; successful
real package initialization and operations at those minima exercise these bounds.

The adapter uses those exact minima. The shared flag, 65,536-page maximum,
worker settings, imports, exports, package files, and binaries remain unchanged.
Equal-width numeric replacements preserve all source positions. The adapter
runs at the existing file-module preparation boundary before transpilation and
source caching, for both Browser and in-guest engines.

Hashing reads each binary through one 8 KiB buffer. It adds one equal-sized
loader string and no full binary copy or retained adapter cache. Unrelated
module paths return the borrowed source before hashing or filesystem access.

Initial logical capacity across the three packages falls from 786,432,000 to
192,806,912 bytes. This is a capacity reduction, not an RSS measurement or an
explanation of Safari's process footprint.

## Checks and limits

`checks/runtime-oxc-memory.json` keeps the checks under the existing runtime
owner. `bun test scripts/oxc-memory.test.ts` downloads the immutable tarballs,
compiles only the private adapter, and exercises actual parser, transform, and
minify operations with its output. It also checks a larger input, wrong minima,
source positions, unchanged package files, and caller errors.

These are reduced adapter-output controls, not execution of a newly compiled
guest. Normal CI builds the changed cores. With the pinned test dependencies,
stock Node async parser and transform currently fail in Emnapi's worker setup.
Native Bun 1.4.4 fails loading the stock bindings because its WASI object lacks
`initialize`. The controls preserve and expose those baseline limitations.

[Ledger scope and pinned revisions](scope.md).
