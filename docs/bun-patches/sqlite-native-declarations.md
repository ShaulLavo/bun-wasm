### SQLite native declarations

`crates/bunwasm-runtime/src/js/sqlite_types.d.ts`. Class **Host feature**. Original declaration adapter for the existing `src/sqlite.rs` native calls, not a copied upstream implementation. It distinguishes database and statement handles, all four row modes, nullable results, safe integer row IDs, and native metadata. The declarations describe normalized wrapper calls. No upstream source path or revision applies to this adapter.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/sqlite_types.d.ts`](#sqlite-native-declarations) | Host feature | Original declarations for the existing Rust SQLite calls and dynamic result modes. |

[Parent context](bun-patch-series.md).
