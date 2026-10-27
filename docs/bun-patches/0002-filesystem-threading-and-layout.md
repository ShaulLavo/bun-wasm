### 0002 filesystem threading and layout

File `0002-wasm-sys-dir-iterator-stat-futex-watcher-spawn-types.patch`. Class **Port**.

Add a `readdir`-based directory iterator, WASI stat timestamps, platform types, errno conversions, and WASI watcher stubs. Supply futex operations for a single-thread runtime and gate further 64-bit AST, FFI, HTTP, parser, and source-map layout assertions. Finish cfg corrections from 0001, including removing its duplicate page-size fallback and separating Unix-only Rust APIs from WASI APIs.

Without it directory resolution is unavailable, platform definitions do not type-check, and layout assertions reject wasm32. The watcher does not create native OS watches. Browser file changes are driven by the host. These are port choices rather than fixes to native Bun behavior.

Files touched, relative to `vendor/bun/`:

- `src/analytics/lib.rs`
- `src/ast/b.rs`
- `src/ast/e.rs`
- `src/ast/expr.rs`
- `src/ast/lib.rs`
- `src/ast/nodes.rs`
- `src/ast/stmt.rs`
- `src/ast/symbol.rs`
- `src/bun_alloc/lib.rs`
- `src/bun_core/lib.rs`
- `src/bun_core/string/SmolStr.rs`
- `src/bun_core/string/immutable.rs`
- `src/bun_core/util.rs`
- `src/cares_sys/c_ares.rs`
- `src/collections/array_hash_map.rs`
- `src/errno/wasi_errno.rs`
- `src/event_loop/ConcurrentTask.rs`
- `src/http_types/h2.rs`
- `src/md/parser.rs`
- `src/paths/lib.rs`
- `src/semver/lib.rs`
- `src/sourcemap/InternalSourceMap.rs`
- `src/sourcemap/Mapping.rs`
- `src/spawn_sys/lib.rs`
- `src/sys/PosixStat.rs`
- `src/sys/fd.rs`
- `src/sys/lib.rs`
- `src/sys/linux_syscall.rs`
- `src/sys/sys_uv.rs`
- `src/threading/Futex.rs`
- `src/threading/ThreadPool.rs`
- `src/uws_sys/Loop.rs`
- `src/uws_sys/SocketContext.rs`
- `src/uws_sys/SocketGroup.rs`
- `src/watcher/INotifyWatcher.rs`
- `src/watcher/WasiWatcher.rs`
- `src/watcher/Watcher.rs`
- `src/watcher/WindowsWatcher.rs`
- `src/watcher/lib.rs`
- `src/windows_sys/externs.rs`


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0002](#0002-filesystem-threading-and-layout) | Port | Add WASI directory iteration, stat, watcher, and single-thread primitives. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
