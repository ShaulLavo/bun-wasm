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

`real-guest.ts` adapts the original diagnostic
`next-finalization/probes/nft-repro.cjs`. Its entry and ignore selection follows
Next 15.5.6's `next/dist/build/collect-build-traces.js` and
`next/dist/build/webpack/plugins/next-trace-entrypoints-plugin.js`, as distributed
in the pinned npm package. It preserves real guest path, filesystem and module
calls, removes timing-only analysis bookkeeping, and records complete sorted
file/ESM lists and stable warning name/code/message fields. It adds an executable
arithmetic/path positive control in the same guest context. Next package source
and lock identities belong in each caller's hashed installed-input manifest.

The pure replay fixture adds the same arithmetic control and a result marker,
emits full file/ESM and warning lists, and rejects stub use even when the traced
code catches the stub's exception. Its historical short-hash/count check stays
in place alongside the maintained runner's complete external output oracle.
`replay-small.json` has four original tiny module bodies, not Next source, and
exists only to test callback, output-drift and missing-input behavior cheaply.

The maintained profile classifier adapts the audit's original
`tools/profile-boundaries.ts`. It uses the saved profile's actual sample entries,
validates a complete node tree, caches subtree counts, rejects absent captures,
and uses node unions for overlapping inclusive totals. It distinguishes useful
Wasm callee samples from JavaScript/wrapper samples before reentry. The classifier
does not collect profiles or change the browser observer.

The Rust counter replaces the audit's original `tools/icount.c` using Linux
`perf_event_open`, `wait4` and child-subreaper interfaces. It adds counter error
rejection, per-event enabled/running metadata, fixed multiplexing rejection,
explicit affinity selection on hybrid CPUs, and descendant cleanup. It uses no
upstream copied implementation or additional dependency. None of these tools is
linked into the guest or listed in the package release payload.
