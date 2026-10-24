### 0010 semantic import locations

File `0010-wasm-expose-semantic-dynamic-import-locations-to-the.patch`. Class **Host feature**.

Upstream paths are `src/js_parser/lib.rs`, `src/js_parser/parse/parse_import_export.rs`, and `src/js_printer/lib.rs` at pinned Bun revision `9510e74152073d850a18758ca41114d8f214ffa6`. A scoped, thread-local parser collector records the original UTF-8 keyword offset when Bun scans a dynamic import expression. A printer collector records emitted UTF-8 spans for static paths and dynamic keywords during the existing transpile pass. Both restore the previous collector on return or unwind. Import.meta and property names never enter the dynamic-import branches. Parsing and printing otherwise behave unchanged.

The original adapters in `crates/bunwasm-transpiler/src/lib.rs`, `crates/bunwasm-cli/src/main.rs`, and `crates/bunwasm-runtime/src/{transpiler,modules,engine_host}.rs` return spans with transpiled code and cache them by source path. Transformed modules are not parsed again for linking. Unchanged JavaScript reuses the AST and dynamic-import locations from the parse already required for module classification, skips printing and keeps original source offsets. For `.mjs` and `.cjs`, whose extensions already decide the format, Bun's scan-only parser supplies imports without a full transform. An absence check for `import` and `from` skips that scan when neither can occur. The scan adapter changes a leading `#!` into `//` before parsing, matching runtime normalization and preserving all UTF-8 byte offsets, including CRLF and Unicode prefixes. Eval sources use Bun's scan-only parser once; an absence check for `import` and `from` skips eval scanning when no import or re-export is possible. The ESM-to-CJS adapter sets a scoped referrer so the bundler printer emits dynamic-import hooks directly, then caches its output. It does not scan the bundle again. Host prologues shift the stored byte spans without parsing. The import arguments remain intact, including import attributes and template substitutions. This is a bun-wasm host requirement, not an upstream Bun bug.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0010](#0010-semantic-import-locations) | Host feature | Collect semantic import locations in Bun's scan and print passes for host module linking. |

[Parent context](bun-patch-series.md).
