### 0001 platform selection and pointer layout

File `0001-wasm-wasi-arms-for-alloc-core-errno-32-bit-pointer-t.patch`. Class **Port**.

Select the POSIX-like code for WASI, add WASI errno definitions, and keep bare wasm stubs separate. Enable real printing, environment access, number formatting, paths, and I/O. Adapt `SmolStr`'s stored pointer word, allocator tags, and `EncodedSlice` pointer tags to 32 bits. Gate native ABI assertions on 64-bit pointers. The 32-bit encoded pointer scheme requires linear memory below 512 MiB, enforced by our link flags.

Without it the toolchain crates fail to compile for WASI, 64-bit constants overflow, and bare-wasm branches drop output or return incomplete results. These are support additions for a target Bun does not ship. An explicit 64-bit assertion is a target restriction, unlike the silently incorrect algorithm in 0007.

Files touched, relative to `vendor/bun/`:

- `src/ast/e.rs`
- `src/bun_alloc/arena_box.rs`
- `src/bun_alloc/baby_vec.rs`
- `src/bun_alloc/basic.rs`
- `src/bun_alloc/lib.rs`
- `src/bun_core/Global.rs`
- `src/bun_core/debug.rs`
- `src/bun_core/env_var.rs`
- `src/bun_core/lib.rs`
- `src/bun_core/output.rs`
- `src/bun_core/string/SmolStr.rs`
- `src/bun_core/string/mod.rs`
- `src/bun_core/tty.rs`
- `src/bun_core/util.rs`
- `src/crash_handler/lib.rs`
- `src/dotenv/env_loader.rs`
- `src/errno/lib.rs`
- `src/errno/wasi_errno.rs`
- `src/event_loop/SpawnSyncEventLoop.rs`
- `src/glob/GlobWalker.rs`
- `src/io/PipeReader.rs`
- `src/io/PipeWriter.rs`
- `src/io/lib.rs`
- `src/io/openForWriting.rs`
- `src/io/posix_event_loop.rs`
- `src/js_parser/parse/parse_entry.rs`
- `src/js_printer/renamer.rs`
- `src/md/ansi_renderer.rs`
- `src/opaque/lib.rs`
- `src/paths/resolve_path.rs`
- `src/paths/string_paths.rs`
- `src/resolver/fs/stat_hash.rs`
- `src/resolver/lib.rs`
- `src/resolver/resolver.rs`
- `src/semver/lib.rs`
- `src/sourcemap/Mapping.rs`
- `src/spawn_sys/lib.rs`
- `src/spawn_sys/spawn_process.rs`
- `src/sys/PosixStat.rs`
- `src/sys/dir.rs`
- `src/sys/file.rs`
- `src/sys/lib.rs`
- `src/threading/ThreadPool.rs`
- `src/uws_sys/SocketContext.rs`
- `src/windows_sys/externs.rs`


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0001](#0001-platform-selection-and-pointer-layout) | Port | Select WASI implementations and support 32-bit layouts and pointer tags. |

[Parent context](bun-patch-series.md).
