# Performance replay fixture and tools

Classification: original adapter. No upstream production patch.

The frozen `tests/performance/fixtures/nft-replay.cjs` adapts the retained audit's
`harness/nft-harness.js`, produced on November 11, 2026 for Next 15.5.6.
The audit's frozen JSON contains the exact 15 loaded compiled module sources
and recorded filesystem callback results. It is supplied explicitly, outside
the package and Wasm release payloads. The parent SpiderMonkey frameworks lane
owns that retained input and may delete it after replacement evidence lands.

The JavaScript file is an intentional engine input. It runs unchanged in the
bare SpiderMonkey shell and guest, which cannot execute host TypeScript.
Maintained orchestration is TypeScript and the Linux counter is Rust. The
adapter uses the fixture's path-browserify and callbacks, so it cannot measure
the production node:path adapter's payoff. A real guest trace is a distinct
workload and must retain its guest filesystem, module loader, and node:path.

The historical callback field `readBytes` counts JavaScript string code units,
not independently measured UTF-8 bytes. The short file-list hash is a comparison
check, not SHA-256 provenance. New captures compare the full sorted result and
warning lists, all callback counts, and empty stub use.
