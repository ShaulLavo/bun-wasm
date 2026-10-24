### Node path

`vendor/bun/src/node_path/lib.rs`, Bun upstream revision
`9510e74152073d850a18758ca41114d8f214ffa6`. The path sources are unchanged in
the measured WASI checkout `5e0baa66516f3af00b008cdf1521c681317741e8`.
Class **Port**. The existing `bun_node_path` crate is a direct dependency, with no
source changes. Its POSIX and Windows basename,
dirname, extname, isAbsolute, normalize, join, and parse algorithms run on
`u16` slices. These are the same algorithms Bun's runtime and toolchain use.
The previous partial Node POSIX implementation in `src/js/path.js` is removed.

`crates/bunwasm-runtime/src/node_path.rs` and `src/js/path.ts` are **Host feature**
original adapters. Little-endian UTF-16 buffers preserve JavaScript code units,
including lone surrogates and U+FEFF. JavaScript validates and converts arguments
before native calls. The adapter implements POSIX resolve, relative, format, namespace
conversion, and `_makeLong` over the native lexical operations and guest
`process.cwd()`. Bun's native resolve and relative functions read a process-wide
filesystem singleton, so calling them directly would use the toolchain's cwd
instead of the current guest cwd. The adapter does not initialize or change
that shared state.

`scripts/generate-node-path.ts` extracts Bun's Windows resolver, tail normalizer,
and six private helpers from the same upstream file. Class **Port**. It replaces the
two cwd reads with a supplied guest cwd slice and specializes the tail normalizer
to Windows. Bun's device selection, separator handling, tail normalization and
output writes remain unchanged. The generated upstream functions retain their
original control flow. Dependency imports come through the authored adapter so
Cargo dependency analysis sees the crates used by generated source. The original
host adapter passes validated UTF-16 paths
and the current guest cwd to this resolver. It replaces the previous handwritten
Windows resolution algorithm, which could create a false UNC root by joining
cwd `/` and a relative tail before normalization.

The generator also extracts each relative function's computation after its
resolution preamble. It specializes `T` to `u16` and accepts resolved input slices
instead of reading cwd. Bun's comparisons, separator scans, UNC rules, and output
writes remain unchanged. The generator rejects an unexpected source shape or
residual cwd dependency. Argument traversal and suffix-before-path validation adapt
`src/runtime/node/path.rs` at the same revision. POSIX resolution stops checking
arguments at an absolute path; Windows resolution validates every argument.
`matchesGlob` uses the existing Bun glob native and normalizes
Windows separators, matching `src/js/node/path.ts` at the same revision.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`vendor/bun/src/node_path/lib.rs`](#node-path) | Port | Run Bun's unmodified POSIX and Windows path algorithms over UTF-16 slices. |
| [`scripts/generate-node-path.ts`](#node-path) | Port | Extract Bun's relative-path computation with guest-resolved paths supplied by the adapter. |
| [`vendor/bun/src/runtime/node/path.rs`](#node-path) | Port | Adapt the public path argument traversal and validation order to the JavaScript boundary. |
| [`crates/bunwasm-runtime/src/js/path.ts`](#node-path) and `src/node_path.rs` | Host feature | Original adapters for JavaScript validation, guest cwd, and lossless UTF-16 transport. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
