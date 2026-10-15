# Changes to Bun and vendored dependencies

This ledger covers the Bun patch series and all other local changes to third-party source at this revision. Bun is pinned to `9510e74152073d850a18758ca41114d8f214ffa6` by `scripts/sync-bun.sh`. WebKit is Bun's fork at `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`, pinned in `jsc/common.sh`.

Each row has one class. A file with independent changes has separate rows.

- **Port** means the change is required by wasm32, WASI, or the browser. Missing support for this new target is not a Bun bug.
- **Host feature** means bun-wasm adds a hook or behavior for its host.
- **Upstream bug** means the original code is incorrect independently of the new host. This includes incorrect 32-bit algorithms even when the distributed native Bun binary cannot reach them.

| Patch or source | Class | Change |
| --- | --- | --- |
| [0001](#0001-platform-selection-and-pointer-layout) | Port | Select WASI implementations and support 32-bit layouts and pointer tags. |
| [0002](#0002-filesystem-threading-and-layout) | Port | Add WASI directory iteration, stat, watcher, and single-thread primitives. |
| [0003](#0003-transpiler-dependencies) | Port | Supply WASI wakers, CPU features, crash, and resolver implementations. |
| [0004](#0004-inline-thread-pool) | Port | Drain scheduled tasks on the calling thread. |
| [0005](#0005-monotonic-timer) | Port | Use WASI's monotonic clock instead of the bare-wasm timer stub. |
| [0006](#0006-open-flags-and-file-descriptor-paths) | Port | Adapt WASI open flags and track paths for opened descriptors. |
| [0007](#0007-string-equality) | Upstream bug | Correct string comparisons that skip bytes with 32-bit `usize`. |
| [0008](#0008-await-context-hooks) | Host feature | Add optional printer hooks to preserve browser async context. |
| [0009](#0009-bake-completion) | Port | Complete bake bundles through the synchronous WASI event loop. |
| [`jsc/webkit-wasi.patch`, platform hunks](#webkit-platform-hunks) | Port | Compile the C-loop interpreter and WTF for WASI. |
| [`jsc/webkit-wasi.patch`, module slots](#webkit-module-import-slots) | Upstream bug | Give import slots a full JSValue stride and initialize the whole slot. |
| [`jsc/webkit-wasi.patch`, non-JIT declarations](#webkit-non-jit-declarations) | Upstream bug | Expose a required enum without DFG and add two missing includes. |
| [`third_party/libc/src/wasi/mod.rs` and `posix_compat.rs`](#libc) | Port | Declare missing WASI POSIX types and functions. |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, call locations](#quickjs) | Host feature | Match JSC's call-site stack columns. |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, inspection helpers](#quickjs) | Host feature | Inspect keys and iterator entries without consuming them. |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, async context](#quickjs) | Host feature | Capture and restore async context in promise reactions. |
| [`third_party/rquickjs-sys/build.rs`](#quickjs) | Host feature | Rebuild when the locally patched C sources or binding header change. |
| [`jsc/build-icu.sh`, makefile rewrite](#icu) | Port | Select a usable cross-build makefile without native assembly output. |
| [`jsc/build-icu.sh`, filtered ICU data](#icu) | Port | Reduce the embedded locale data to fit the wasm memory budget. |
| [`scripts/sync-bun.sh`, generated linker config](#nested-bun-dependencies) | Port | Remove Bun configure's generated host linker override. |
| [`vendor/bun/vendor/rust-argon2`, inherited patch](#nested-bun-dependencies) | Host feature | Preserve Bun's low-memory Argon2 hash verification behavior. |
| [`crates/bunwasm-glue/src/bun_native.rs`](#copied-and-generated-bun-source) | Port | Replace standalone parser base64 and zlib stubs with working Rust implementations. |
| [`crates/bunwasm-runtime/src/js/temporal.js`](#temporal) | Host feature | Package the unmodified Temporal polyfill for engines without Temporal. |

## Bun patch series

The filenames below are relative to `patches/bun/`. Their diffs are the complete source of truth, including each affected file. The file inventories are included so a reader can check coverage without applying the patches.

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

### 0003 transpiler dependencies

File `0003-wasm-io-waker-crash-handler-resolver-bun_transpiler-.patch`. Class **Port**.

Add WASI CPU-feature reporting, crash-handler branches, an inert I/O waker, WASI resolver stat hashing, and platform selection for the mini event loop. Without it the transpiler's dependency graph cannot type-check for WASI or references native platform machinery. WASI has neither native CPUID nor Bun's native wake mechanism.

Files touched, relative to `vendor/bun/`:

- `src/crash_handler/CPUFeatures.rs`
- `src/crash_handler/lib.rs`
- `src/io/lib.rs`
- `src/resolver/fs/stat_hash.rs`
- `src/resolver/lib.rs`

### 0004 inline thread pool

File `0004-wasm-thread-pool-runs-scheduled-tasks-inline-on-sing.patch`. Class **Port**.

`src/threading/ThreadPool.rs` drains its task queue inline on wasm without atomics. Nested schedules on the same pool are handled by the outer drain loop, and `warm` starts no workers. Without it the bundler tries to spawn unsupported threads and cannot complete its parse work. Native thread scheduling is unchanged.

### 0005 monotonic timer

File `0005-wasm-Instant-backed-system-timer-on-wasi.patch`. Class **Port**.

`src/perf/system_timer.rs` selects the existing `Instant` implementation for WASI, leaving the timer stub for bare wasm. Without it the resolver's timer reset takes the unsupported stub path. WASI supplies a monotonic clock, while bare wasm does not require one. Native Bun already uses `Instant`.

### 0006 open flags and file descriptor paths

File `0006-wasm-openat-access-mode-and-fd-paths-on-wasi.patch`. Class **Port**.

`src/sys/lib.rs` supplies `O_RDONLY` when an open has no access-mode bits and calls bun-wasm's fd-path bookkeeping when descriptors open and close. `get_fd_path` reads that bookkeeping. Without it an `O_DIRECTORY`-only open fails with `EINVAL` because WASI's `O_RDONLY` is nonzero, and the resolver cannot recover a descriptor's path. Native targets have different flags and fd-path facilities.

### 0007 string equality

File `0007-wasm-strings-eql-compares-8-byte-words-on-32-bit-tar.patch`. Class **Upstream bug**.

`src/bun_core/string/immutable.rs::eql_long` counts eight-byte words but originally loads and advances by `usize`. It also skips its four-byte tail on 32-bit targets. Read eight-byte words consistently and always check the four-byte tail. Without it different strings can compare equal, causing incorrect identifier matching and minified loop labels.

This classification is a judgment about the algorithm, not a claim that native Bun 1.4.2 ships a broken 32-bit binary. The same Rust function is incorrect on any 32-bit platform. Extracting the exact unpatched function from the pinned source gives `eql(b"abcd", b"wxyz", true) == true` on wasm32 and `false` on native x86_64. The patched function returns `false` on wasm32. The installed native Bun 1.4.2 is 64-bit and does not reach the faulty width case.

The ready-to-file report and complete standalone Rust reproduction are in the owner's `/work/reports/upstream-bugs/README.md` and `bun-wasm-eql/repro.rs` beside it. No upstream issue has been posted.

### 0008 await context hooks

File `0008-wasm-optional-await-hooks-in-the-printer-for-a-host-.patch`. Class **Host feature**.

`src/js_printer/lib.rs` adds `BUNWASM_AWAIT_HOOKS`, off by default. It prints `await x` through `__bunwasm_capture` and `__bunwasm_resume`, and adds matching hooks around `for await` bodies and after loops. Labeled loops keep valid `continue` targets. The browser runtime enables this during its own transpiles, never for ordinary `bun build` output.

Without it browser-engine `AsyncLocalStorage` loses its frame across suspension because that host lacks Bun's engine integration. This adds a host contract, not a repair to Bun's normal printer output.

### 0009 bake completion

File `0009-Drive-bake-completion-from-the-WASI-mini-event-loop.patch`. Class **Port**.

`src/bundler/bundle_v2.rs` exposes `finish_wasi_dev_server` to wait for parsing and call the existing bake completion path. Without it bun-wasm's synchronous mini event loop cannot drive the native asynchronous completion task, so dev-server bundles cannot finish through that path. Native bake already schedules its completion.

## Other vendored changes

### WebKit platform hunks

File `jsc/webkit-wasi.patch`. The following hunks have class **Port**.

| WebKit file | Change | What breaks without it |
| --- | --- | --- |
| `Source/JavaScriptCore/CMakeLists.txt` | Link the two LLInt extractors with imported memory. | wasm-ld trims trailing zero data that offlineasm expects to scan. |
| `Source/JavaScriptCore/heap/RegisterState.h` | Avoid `setjmp` and provide an inert WASI register-state structure. | WASI has no supported native register-spill API. Wasm locals need the separate spill-pointers finalization. |
| `Source/JavaScriptCore/runtime/JSCBytecodeCacheVersion.cpp` | Exclude `dlfcn.h` for WASI. | The dynamic-loader header is unavailable. |
| `Source/JavaScriptCore/runtime/Options.cpp` | Add the WASI `size_t` parser specialization. | WASI's distinct integer types leave the option parser without an implementation. |
| `Source/WTF/wtf/PlatformHave.h` | Disable the resource-header capability on WASI. | Native resource API assumptions fail. |
| `Source/WTF/wtf/PlatformOS.h` | Define `OS(WASI)` and include it in Unix-like selection. | WASI gets no usable platform selection. |
| `Source/WTF/wtf/PlatformRegisters.h` | Avoid the native ucontext header. | The header is unavailable. |
| `Source/WTF/wtf/RandomDevice.cpp` | Use `getentropy` in chunks of at most 256 bytes. | WASI has no `/dev/urandom` path. |
| `Source/WTF/wtf/RawHex.h` | Include WASI's distinct 32-bit integer overloads. | The integer overload set is incomplete for the WASI ABI. |
| `Source/WTF/wtf/StackBounds.cpp` | Read wasm-ld's shadow-stack bound symbols. | Native pthread stack discovery cannot find the wasm shadow stack. |
| `Source/WTF/wtf/dtoa/utils.h` | Recognize wasm's correct double operations. | double-conversion rejects the unrecognized architecture at compile time. |
| `Source/bmalloc/libpas/src/libpas/pas_lock.h` | Accept WASI in the lock platform selection. | The header rejects this target even though bmalloc is disabled. |
| `Source/cmake/OptionsJSCOnly.cmake` | Disable native API tests for WASI. | The cross-build includes unsupported test targets. |
| `Source/cmake/WebKitCommon.cmake` | Recognize CMake's WASI system name. | Configure rejects the OS. |

`jsc/wasi-jsc.cmake`, `jsc/configure.sh`, and `jsc/shim/wasi-compat.{h,c}` plus `madvise.c` are our **Port** configuration and glue, not edits to upstream source. They select the C-loop interpreter, system malloc, single-thread GC, and disabled JIT/Wasm tiers; supply temporary-file helpers and inert signal/scheduling declarations; and link the WASI support library. Without them the target cannot configure or link. `jsc/finalize.sh` runs Binaryen's `--spill-pointers`, without which conservative GC misses references in wasm locals. See [the JSC notes](../jsc/README.md).

### WebKit module import slots

Files `Source/JavaScriptCore/runtime/JSModuleEnvironment.{h,cpp}` in `jsc/webkit-wasi.patch`. Class **Upstream bug**.

Allocate the module record, import count, and each import slot at a full variable-slot stride. Zero the whole import slot before clearing its pointer. Without this, pointer-sized slots on 32-bit targets overlap when addressed through `importSlotScopeOffset` as JSValue-sized variables. An import can resolve to another imported module's binding. Clearing only the pointer also leaves the rest of a JSValue load uninitialized.

The mismatch concerns pointer width and slot addressing, not a missing WASI API. That is why this is an upstream bug. The installed native Bun 1.4.2 uses 64-bit pointers and passes `tests/fixtures/engine-esm-imports`; it cannot exercise the width mismatch. A native 32-bit WebKit build has not been run. The same slot-size relationship makes that configuration suspect, but this ledger does not claim a native 32-bit reproduction. The ready-to-file report in the owner's upstream list records that limit.

### WebKit non-JIT declarations

Files `Source/JavaScriptCore/dfg/DFGAbstractHeap.h`, `Source/JavaScriptCore/runtime/JSModuleLoader.cpp`, and `Source/JavaScriptCore/runtime/VM.cpp` in `jsc/webkit-wasi.patch`. Class **Upstream bug**.

Move `AbstractHeapKind` outside the DFG-only guard because `DOMJIT::Effect` uses it without DFG. Include `<wtf/Scope.h>` in the two translation units that use its helpers. Without these changes the fork's C-loop configuration fails to compile.

This is a judgment call. The build failures are in a non-JIT configuration and do not depend on WASI syscalls or wasm pointer size. They are upstream configuration bugs, although bun-wasm is what needs that configuration. Running the installed native Bun 1.4.2 cannot test missing compile-time declarations. Its default build does not exercise this configuration. A fresh native C-loop build has not been attempted. The owner's ready-to-file report states the source evidence and the unrun native build check separately.

### libc

`third_party/libc` is libc **0.2.186**, selected by `[patch.crates-io]`. Class **Port**.

Only two source files differ from the published crate. `src/wasi/mod.rs` adds the unused POSIX fields to `rusage`, exposes the existing p2 socket definitions on p1, and exports `posix_compat`. New `src/wasi/posix_compat.rs` declares missing mmap, signal, process, spawn, terminal, resource, scheduling, and socket APIs and constants. `bunwasm-posix` supplies absent symbols. Without this layer Bun's POSIX-oriented crates fail to compile or link for wasip1. These declarations describe bun-wasm's shim contract; they do not establish that upstream libc has the wrong WASI ABI.

The vendored package omits upstream tests and Cargo's `.cargo_vcs_info.json`. Other retained source and build files match the published 0.2.186 crate.

### QuickJS

`third_party/rquickjs-sys` is rquickjs-sys **0.13.0**, with its bundled QuickJS-ng. Every change below has class **Host feature**.

| File and area | Change | What breaks without it |
| --- | --- | --- |
| `quickjs/quickjs.c`, parser call locations | Record the callee, property, or constructor position after parsing arguments. | Stack frames and source maps point to QuickJS's argument position instead of Bun/JSC's call position. This is a compatibility policy, not an ECMAScript violation by QuickJS. |
| `quickjs/quickjs.c`, `JS_bunwasm_OwnKeysInOrder` | Return ordinary-object keys in JSC's inspection order, with integer keys sorted and symbols interleaved by insertion. | Bun-compatible console inspection cannot reproduce that order through `Reflect.ownKeys`. |
| `quickjs/quickjs.c`, `JS_bunwasm_IteratorEntries` | Snapshot remaining Map/Set iterator entries without advancing the iterator. | Console inspection either lacks the entries or consumes the user's iterator. |
| `quickjs/quickjs.c`, async context | Store and trace a context value, capture it in promise reactions, restore it for jobs, and expose get/set functions. | QuickJS `AsyncLocalStorage` loses its store across promise and await boundaries. The original engine has no obligation to implement Node's API. |
| `build.rs` | Add rerun tracking for `quickjs` and `quickjs.bind.h`. | Local C changes can leave Cargo using a stale engine until another input invalidates it. This hook supports our fork. |

No existing binding source or C header is modified. Our Rust engine declares the added functions. The vendored tree keeps Linux x86_64 and wasm32-wasip1 bindings and the C files needed by the library, dropping other targets, shell programs, tests, build tooling, and package metadata. It adds the license copy. These packaging choices do not change retained upstream implementations. Every other retained source file matches the published crate.

### ICU

`jsc/build-icu.sh` builds ICU **78.3**. Class **Port** for each of the following changes.

The script copies `source/config/mh-linux` to `mh-unknown` in the wasm source tree and clears `GENCCODE_ASSEMBLY` there. Without this build-time rewrite ICU has no usable WASI platform makefile and attempts unsupported native assembly output. There are no other local ICU source edits.

The script also filters the embedded data to root and English locales and removes converters, transliterators, and Unicode names. This is a data modification, not a C++ source patch. Without filtering the binary carries substantially more locale data against the 512 MiB wasm limit. Other locales fall back to root. Flags disable mmap, dynamic loading, and native timezone globals. These are port configuration decisions.

### Nested Bun dependencies

`scripts/sync-bun.sh` fetches Bun's pinned `oven-sh/lol-html` and `sru-systems/rust-argon2`. There are no bun-wasm edits to lol-html.

It applies Bun's own `patches/rust-argon2/legacy-low-memory.patch` to rust-argon2's `src/common.rs` and `src/context.rs`. Class **Host feature**. This inherited Bun extension accepts nonzero memory costs below `8 * lanes` and pads allocated memory, so hashes produced by Bun's legacy low-memory behavior can still verify. Without it those hashes are rejected by the dependency. This is Bun's existing application policy, not a new wasm fix or a bug in rust-argon2. The patch also updates the dependency's tests.

Bun's configure generates its normal Rust build options and byte-class tables. `sync-bun.sh` removes the configure-generated `.cargo/config.toml` so its host linker selection does not override ours. That removal is **Port** build configuration. No build script rewrites Bun Rust source beyond the exported patch series. `scripts/wasify.py` is an editing helper, not an invoked build transformation. Its exported edits belong to the patch series above.

### Copied and generated Bun source

`crates/bunwasm-glue/src/bun_native.rs` copies the pinned Bun file `src/sema/standalone/native.rs`. Class **Port**. Its only implementation changes supply base64 length, encode, strict decode, and lenient decode functions and a working `compress2` backed by `miniz_oxide`. The standalone parser intentionally leaves these as stubs. Without replacements wasm bundling paths that need base64 or compression fail. This does not repair the native Bun implementations, which link their real libraries.

`crates/bunwasm-build/generated/bake.client.js` and `bake.error.js` are Bun's generated HMR and error-overlay bundles. `scripts/generate-bake.sh` runs the pinned upstream generator and copies the output without a local source rewrite. The imported incremental graph, packed map, and serialized-failure modules are referenced directly from `vendor/bun` without additional edits. Our adapters around them are bun-wasm source.

### Temporal

`third_party/temporal/entry.js`, `package.json`, and `bun.lock` pin `@js-temporal/polyfill` **0.5.1** and **jsbi 4.3.2**. Class **Host feature** for packaging the fallback.

`scripts/vendor-temporal.py` bundles the unmodified packages, minifies them, and wraps the CommonJS output as a factory in `crates/bunwasm-runtime/src/js/temporal.js`. Without the wrapper our engine cannot load the fallback used for Bun's TOML date values. There are no local changes to either dependency's source. The entry, lockfile, and copied licenses record its provenance.

## Port bugs fixed in bun-wasm's own code

### Zero-length stdin reads waited for EOF

`crates/bunwasm-runtime/src/natives.rs`, native `read` callback. A zero-length stdin read called `std::io::stdin().read` with an empty buffer. Rust's buffered stdin reader fills its internal buffer when empty, causing an 8 KiB WASI read that waits for input or EOF. `fs.readSync(0, new Uint8Array(0), 0, 0, null)` therefore hung on an open pipe. Native Bun 1.4.2 returns `0` immediately.

Return an empty byte result for fd 0 before entering buffered stdin when the requested buffer is empty. Other fds use unbuffered `File::read` after lookup in our fd table, so they do not have this buffered-stdin cause. Their error and seek paths are preserved. Callback `fs.read` and promise `FileHandle.read` delegate to `readSync`, which calls this native. `readv` and `readvSync` are not implemented. Full-stream `readStdin` intentionally reads until EOF and is a different operation.

QuickJS, JSC, and the browser-host engine install the same native table, so the fix applies to all three. No Bun or third-party source changes for this fix. The fixture `tests/fixtures/fs-empty-read` covers empty and nonempty destination buffers with zero requested length, options, regular files, invalid descriptors, callbacks, and promises. `tests/test-empty-stdin.py` holds a pipe open until the guest exits and kills and reaps it on timeout. Closing the pipe as test input would conceal the defect.

The normal `scripts/test.sh` runner uses the open-pipe driver for this fixture. Reproduce under wasmtime with `source env.sh && python3 tests/test-empty-stdin.py`. The same test accepts `--engine native`, `--engine jsc`, and `--engine browser`; browser runs the host-engine wasm through Node's V8 and WASI host. This is an engine-host regression, not a browser UI test.

## Audit method

The inventory comes from `patches/bun/*.patch`, `git ls-files jsc third_party vendor`, the source-copy provenance above, and searches for patch, replacement, and source-write operations in `scripts/`, `jsc/`, and crate build scripts. Retained libc and rquickjs-sys files were compared byte-for-byte with the matching published crates in Cargo's registry. The `vendor/bun` working tree must be clean after applying all nine commits. There are no additional unexported Bun source modifications in the audited checkout.

SQLite is supplied by the unmodified `libsqlite3-sys` crate. `.cargo/config.toml` sets its documented compile flags to match Bun where possible and disable unsupported WASI facilities; it does not rewrite the amalgamation. No additional third-party source rewrites were found in crate build scripts. Test fixture npm packages are source inputs for compatibility tests, not runtime forks.
