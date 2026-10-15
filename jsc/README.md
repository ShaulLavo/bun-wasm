# JavaScriptCore for wasm32-wasip1 (experimental)

Bun's own engine, JavaScriptCore from Bun's WebKit fork at the commit Bun pins
(`vendor/bun/scripts/build/deps/webkit.ts`), compiled to `wasm32-wasip1`, and `bun-jsc.wasm`, a
second `bun` that runs on it. The default engine is still QuickJS (`crates/bunwasm-runtime`);
this is the experiment that shows how far Bun's real engine gets.

```sh
scripts/build-jsc.sh        # WebKit checkout, ICU, JSC static libs, jsc.wasm (the jsc shell)
scripts/build-bun-jsc.sh    # dist/bun-jsc.wasm (crates/bunwasm-jsc)
scripts/test-jsc.sh         # tests/jsc fixtures vs native Bun (--fixtures tests/fixtures: the QuickJS suite)
scripts/bench-jsc.sh        # tests/bench/micro.js on dist/bun.wasm and dist/bun-jsc.wasm

wasmtime run --dir .::/ dist/bun-jsc.wasm run /app.ts
```

Everything the build produces goes to `${JSC_BUILD_DIR:-/work/tmp/bun-wasm-jsc}`, never the repo.
A full build from nothing takes about 10 minutes at `-j6` on this machine (ICU ~3, JSC ~6). Every compile step runs inside
`systemd-run --user --scope -p MemoryMax=5G -p CPUWeight=20 nice -n 10` (`CAGE=` turns that off,
`JOBS=` sets the parallelism).

## What JSC is built as

- `PORT=JSCOnly`, `USE_BUN_JSC_ADDITIONS=ON` (as Bun ships it), static libraries.
- The C loop interpreter (`ENABLE_C_LOOP`): wasm can't generate code at run time, so no JIT tier
  (LLInt asm, baseline, DFG, FTL) and no WebAssembly.
- System malloc (wasi-libc's dlmalloc), no bmalloc/libpas, no mimalloc.
- wasip1, single-threaded: pthreads are wasi-libc's stubs, so there is no concurrent or parallel GC.
- ICU 78.3 (Bun's version) for common + i18n, data filtered to root/en (8 MB instead of 33 MB) and
  linked in as `icudt78_dat`. `Intl` works for English; other locales fall back to root.
- 512 MiB memory cap (`--max-memory=536870912`), the cap bun-wasm needs for Bun's pointer tags.

## Files

| File | What |
|---|---|
| `webkit-wasi.patch` | The WebKit patch (19 files, +88/-15 lines), mostly `OS(WASI)` arms |
| `shim/wasi-compat.h` | Forced into every WebKit TU: inert POSIX signal API (`sigaction` etc.), `mkostemp`, `mkdtemp`, sched params |
| `shim/wasi-compat.c`, `shim/madvise.c` | Their implementations (`libwasi-compat.a`; `madvise` is its own member so links with bunwasm-posix don't pull a duplicate) |
| `wasi-jsc.cmake` | CMake toolchain (wasi-sdk) |
| `common.sh` | Paths, pinned versions, the memory cage |
| `fetch-webkit.sh` | Sparse, blobless checkout of oven-sh/WebKit at the pin, patch applied |
| `build-icu.sh` | ICU host build (data tools), wasm build, filtered static data |
| `configure.sh`, `build.sh` | CMake configure and ninja build (also builds the shim, installs Ruby's `erb` gem if missing) |
| `finalize.sh` | `wasm-opt --spill-pointers -O2 --strip-debug`; every binary containing JSC needs it |

The patch, by area:

- Platform: `OS(WASI)` in WTF and CMake, stack bounds from wasm-ld's `__stack_low`/`__stack_high`,
  randomness from `getentropy`, no `sys/ucontext.h`/`rusage.ru_maxrss`/`setjmp` (the GC's register
  spill is a no-op: wasm has no registers in memory), libpas's lock header accepts WASI.
- wasm32 types: `size_t`/`uintptr_t` are `unsigned long`, distinct from `unsigned`
  (`RawHex`, the Options parser), like Darwin.
- The LLInt offset/settings extractors link with `--import-memory`: offlineasm scans those
  binaries for its tables, and wasm-ld otherwise trims trailing zero bytes off data segments.
- Bit rot in the fork's non-JIT configuration: `DFGAbstractHeap.h` guards an enum that
  `DOMJITEffect.h` uses even without the DFG, and two missing `<wtf/Scope.h>` includes.
- A 32-bit bug in the fork's module import slots (`JSModuleEnvironment.h`): the slots are
  pointer-sized but addressed as JSValue-sized variables (`importSlotScopeOffset`, and the LLInt's
  `loadq` in `op_resolve_scope`), so with 4-byte pointers import slots 0 and 1 shared a variable
  and the second import read the first one's module (`import a from "./c"; import { f } from
  "./b"` made `f` read `c`'s binding). Each slot now takes a whole variable slot. Bun only ships
  64-bit builds, so it never shows there; `tests/jsc/esm-imports` covers it.

## The GC and `--spill-pointers`

JSC's collector finds live objects by scanning the native stack conservatively. In wasm, C++ and
Rust locals live in wasm locals, outside linear memory, so the scan misses them and the GC frees
live cells: without the spill step, `gc5.js`-style tests deterministically produce wrong values
(an array referenced by a live object is collected and its cell reused). binaryen's
`--spill-pointers` copies pointer-sized locals to the C stack around calls, where the scan sees
them. Cost: about +50% code size (14 MB -> 22 MB for the jsc shell) and 5-15% run time. The
JavaScript stack itself (the C loop's register file) is in linear memory and was always scanned.

## Memory under the 512 MiB cap

`gc.js`/`stress.js` (churn with ~40 MB live) pass. Measured limits at 512 MiB:

- typed arrays: ~485 MiB live before `RangeError: Out of memory`;
- small objects (`{a: n, b: "s" + n}` in one array): ~3 million live (QuickJS: ~4 million);
- allocating 64 MiB buffers after the heap has peaked at ~250 MB fails (dlmalloc can't reuse the
  fragmented space for one contiguous block); 16 MiB buffers in the same churn pass.

When the GC heap itself runs out, JSC aborts (`handleResourceExhaustion`) instead of throwing.

## bun-jsc.wasm (crates/bunwasm-jsc)

- `src/sys.rs`: hand-written declarations for the part of the C API used.
- `cpp/helpers.cpp`: what the C API lacks, written against JSC internals and compiled with the
  jsc shell's exact flags (read from `compile_commands.json` by `build.rs`): a global object with
  ES module loader hooks (resolve/fetch/import()/import.meta), the VM lock, explicit microtask
  draining, promise state and Proxy target for `console.log`.
- `src/main.rs`: `bun-jsc run <entry>` bundles the entry with Bun's real bundler
  (`bunwasm-build`, `--target bun --format esm`, inline source map), loads it through JSC's
  module loader, then runs the event loop: timers over WASI clocks, the nextTick queue, then
  microtasks, after every task.
- `src/js/prelude.js`: console, timers, queueMicrotask, process (argv/env/exit/cwd/nextTick/on),
  Bun (version/file/write/sleep/inspect), TextEncoder/TextDecoder, Buffer, `require` for
  fs/path/util/buffer/timers. Formatting comes from bunwasm-runtime's engine-agnostic
  `inspect.js`, `console.js`, `path.js` and `buffer.js` (`include_str!`, read-only). Error stacks
  are converted from JSC's `name@file:line:col` to Bun's `at name (file:line:col)` and mapped
  back through the source map, so uncaught errors print exactly like native Bun, excerpt included.

### One libc

The JSC archives and wasi-sdk's libc++ are compiled against wasi-sdk's wasi-libc, but rustc's
`wasm32-wasip1` target links its own bundled (self-contained) wasi-libc. Two libcs in one link
resolve each symbol from whichever archive the linker meets first, mixing versions. So
`scripts/build-bun-jsc.sh` builds with `-C link-self-contained=no`, and `build.rs` adds what rustc
then leaves out: wasi-sdk's sysroot as the library search path (rustc's `-lc` resolves there),
its `crt1-command.o`, and `libc++`/`libc++abi` from the sysroot's `noeh` directory.
wasi-libc's mman/signal/getpid emulation libraries stay out: bunwasm-posix defines those
functions. The changed `RUSTFLAGS` would invalidate the shared cargo cache, so this build uses its
own target dir (`$JSC_BUILD_DIR/target`).

### Numbers

| | dist/bun.wasm (QuickJS) | dist/bun-jsc.wasm (JSC) |
|---|---|---|
| size | 8.9 MB (3.3 MB gzip) | 40.0 MB (11.3 MB gzip, 8.8 MB zstd -19): 29.9 MB code, 10.1 MB data (8 MB ICU) |
| `tests/bench/micro.js` loop | 210 ms | 280 ms |
| regexp | 122 ms | 72 ms |
| json | 190 ms | 50 ms |
| alloc (GC churn) | 493 ms | 580 ms |
| startup (`console.log(1)`, compiled module cached) | ~60 ms | ~150 ms |

No JIT: tight loops are ~1.35x slower than QuickJS; RegExp (YARR interpreter) and JSON are
1.7x and 3.8x faster.

### Not done

- `bun test`, `bun build`, `-e` beyond plain JS, and most of `node:*` (events, crypto, url,
  zlib, streams, http) and web APIs (URL, fetch, AbortController); `scripts/test-jsc.sh --fixtures
  tests/fixtures` passes 7 of the 49 QuickJS fixtures (typescript, node-path, node-buffer,
  cli-eval, errors-uncaught, errors-rejection, ts-stack-trace). The gap is the polyfill surface, not the
  engine: bunwasm-runtime's JS polyfills are mostly engine-agnostic (see below).
- `err.stack` read by user code keeps JSC's format (only printed errors are converted); the fork
  doesn't honour `Error.prepareStackTrace` without Bun's global object.
- Module-level `import.meta` of modules the bundler inlined refers to the entry.
- VM teardown aborts in `AtomStringImpl::remove`; the binary never destroys its VM.
