### 0006 open flags and file descriptor paths

File `0006-wasm-openat-access-mode-and-fd-paths-on-wasi.patch`. Class **Port**.

`src/sys/lib.rs` supplies `O_RDONLY` when an open has no access-mode bits and calls bun-wasm's fd-path bookkeeping when descriptors open and close. `get_fd_path` reads that bookkeeping. Without it an `O_DIRECTORY`-only open fails with `EINVAL` because WASI's `O_RDONLY` is nonzero, and the resolver cannot recover a descriptor's path. Native targets have different flags and fd-path facilities.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0006](#0006-open-flags-and-file-descriptor-paths) | Port | Adapt WASI open flags and track paths for opened descriptors. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
