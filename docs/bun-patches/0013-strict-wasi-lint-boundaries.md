## 0013 strict WASI lint boundaries

Class **Port**. Upstream remains Bun
`9510e74152073d850a18758ca41114d8f214ffa6`; this patch changes only the WASI port.

- `src/bun_core/util.rs` restores Unix-only reload/spawn blocks. WASI keeps its
  explicit unsupported-reload arm and the existing unsupported-spawn result,
  without entering an unreachable native wait path.
- `src/bun_core/Global.rs` explicitly consumes the unused WASI thread name and
  declares `quick_exit` only on its native callers' targets.
  `src/bun_core/debug.rs` limits the frame offset alias to its x86_64/aarch64 users.
- `src/errno/wasi_errno.rs` drops an unused trait import. `src/sys/copy_file.rs`
  and `src/sys/lib.rs` match native-only imports, directory-entry decoding and
  extended-attribute helpers to their consumers' cfgs.
- `src/threading/ThreadPool.rs` matches `force_spawn` to its threaded caller's
  cfg. `src/threading/Futex.rs` limits the single-thread wake helper's visibility
  to its parent, matching the other platform implementations.
- `src/crash_handler/lib.rs` excludes a native-only import and explicitly
  consumes the report URL on WASI, where automatic crash reporting is disabled.
- `src/io/lib.rs` and `src/io/posix_event_loop.rs` exclude unused native imports.
  Their specific native poller logger, descriptor accessor, packed pollables,
  dispatch helpers and unused WASI waker accessor receive WASI-only `dead_code`
  allowances. `src/watcher/Watcher.rs` and `WatcherTrace.rs` do the same only for
  native filesystem-event buffers, callback, trace and merge/dispatch helpers.
  These declarations remain type-checked. No whole module, authored crate or
  warning category is capped globally, and no Clippy lint is disabled.



## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0013](#0013-strict-wasi-lint-boundaries) | Port | Correct native-only cfgs and mark individual native poller/watcher declarations unused on WASI. |

[Ledger scope and pinned revisions](scope.md).
