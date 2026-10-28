## 0016 wasm32 symbol reservation cap

Class **Port**. The upstream path is `src/js_parser/p.rs` at pinned Bun revision
`9510e74152073d850a18758ca41114d8f214ffa6`.

Upstream pre-sizes three per-file tables from the source length, one symbol per 16 bytes:
the module scope's member table, the parser's symbol list and the symbol-use map. On wasm32
every reservation is committed linear memory, and that memory must stay below 512 MiB because
Bun's string pointer tags use the top three address bits (`crates/bunwasm-cli/build.rs`).
String-heavy generated files hold far fewer symbols than that estimate. A Next.js development
`vendor-chunks/next.js` of 5.6 MiB asked for a 13,107,208-byte member table (512 Ki hash
buckets of 24-byte entries plus control bytes) and the dev server died with "Bun has run out
of memory" while parsing it.

On WASI the estimate is capped at 16 Ki symbols. Larger files grow the same tables as symbols
are declared, which is upstream's behaviour for any file without a hint. Parsing results are
unchanged. Native targets keep upstream's estimate.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0016](#0016-wasm32-symbol-reservation-cap) | Port | Cap the source-sized symbol reservations on WASI. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
