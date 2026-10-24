### Transpiler source-map collector

`crates/bunwasm-transpiler/src/lib.rs`, `ChunkCollector` and its `OnSourceMapChunk` implementation. Class **Port**. Upstream `src/runtime/cli/pm_diff_normalize.rs` at the Bun pin.

Retain the small callback that stores the emitted `bun_sourcemap::Chunk` in an `Option`. The local caller converts its buffer into the returned mappings string. This supplies source maps without the native runtime. The surrounding arena lifecycle, public transpile API, parser module-kind reporting, diagnostic conversion, and await-hook control are local adapters to Bun's parse/print APIs. Module classification uses the pinned parser's export kind, syntax flags and live static import records, rather than searching printed strings. Syntax-free scripts retain package and filename classification, and data loaders report their generated ESM format. `node_fs.js` vectored writes and `natives.rs` counted `write`/`pwrite` calls are original adapters over the host descriptor ABI; no Node implementation is copied. The native vectored operation accumulates complete chunks, returns progress on a short write or a later error, and leaves positioned-write cursors unchanged. Printed CommonJS factories receive Bun's sixth per-module import-meta argument when present; ordinary factories retain five arguments. The parser's real `import.meta` flag takes precedence over `require` and `__dirname` signals when choosing module grammar. They do not copy `src/runtime/api/JSTranspiler.rs` as an implementation.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-transpiler/src/lib.rs`, source-map collector](#transpiler-source-map-collector) | Port | Retain Bun's small printer callback outside its runtime crate. |

[Parent context](bun-patch-series.md).
