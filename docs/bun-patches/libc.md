### libc

`third_party/libc` is libc **0.2.186**, selected by `[patch.crates-io]`. Class **Port**.

Only two source files differ from the published crate. `src/wasi/mod.rs` adds the unused POSIX fields to `rusage`, exposes the existing p2 socket definitions on p1, and exports `posix_compat`. New `src/wasi/posix_compat.rs` declares missing mmap, signal, process, spawn, terminal, resource, scheduling, and socket APIs and constants. `bunwasm-posix` supplies absent symbols. Without this layer Bun's POSIX-oriented crates fail to compile or link for wasip1. The compatibility module reuses p2's existing `MSG_NOSIGNAL` rather than exporting a second ambiguous definition, and imports its types through the parent module without a redundant prelude import. These declarations describe bun-wasm's shim contract; they do not establish that upstream libc has the wrong WASI ABI.

The vendored package omits upstream tests and Cargo's `.cargo_vcs_info.json`. Other retained source and build files match the published 0.2.186 crate.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`third_party/libc/src/wasi/mod.rs` and `posix_compat.rs`](#libc) | Port | Declare missing WASI POSIX types and functions. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
