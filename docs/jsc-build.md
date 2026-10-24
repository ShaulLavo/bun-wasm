# JavaScriptCore for wasm32-wasip1 (experimental)

Bun's own engine, JavaScriptCore from Bun's WebKit fork at the commit Bun pins
(`vendor/bun/scripts/build/deps/webkit.ts`), compiled to `wasm32-wasip1`, and `bun-jsc.wasm`, a
second `bun` that runs on it. The default engine is still QuickJS (`crates/bunwasm-runtime`);
this is the experiment that shows how far Bun's real engine gets.

```sh
scripts/build-jsc.sh        # WebKit checkout, ICU, JSC static libs, jsc.wasm (the jsc shell)
scripts/build-bun-jsc.sh    # dist/bun-jsc.wasm (bunwasm-cli --features engine-jsc)
scripts/test.sh --engine jsc   # the fixture suite on JSC (scripts/test-jsc.sh is a shortcut)
scripts/bench-jsc.sh        # tests/bench/micro.js on dist/bun.wasm and dist/bun-jsc.wasm

wasmtime run --dir .::/ dist/bun-jsc.wasm run /app.ts
```

Everything the build produces goes to `${JSC_BUILD_DIR:-/work/tmp/bun-wasm-jsc}`, never the repo.
After a successful build, `build/jsc/.bunwasm-inputs` stores a SHA-256 stamp of the build-affecting files under
`jsc/`, `scripts/build-jsc.sh`, `env.sh`, the pinned WebKit and ICU inputs, the copied configure inputs under
`inputs/`, and the pinned toolchain versions.
`scripts/build-bun-jsc.sh` checks that stamp before compiling and fails if the prebuild is missing
or was made from different inputs. Rebuild it with `JSC_BUILD_DIR=<dir> scripts/build-jsc.sh`,
or point `JSC_BUILD_DIR` at a fresh directory.

Configure copies the shim sources and CMake toolchain file into `inputs/`. Generated compiler flags
use these copies, so the checkout that configured JSC can be deleted without breaking later engine builds.
The stamp also checks those copies for changes or missing files.

To update an existing prebuild, run one fresh configure, then rebuild:

```sh
JSC_BUILD_DIR=<dir> jsc/configure.sh --fresh
JSC_BUILD_DIR=<dir> scripts/build-jsc.sh
```

`--fresh` discards CMake's cached reference to the old toolchain file, which may belong to a deleted
checkout. Configure copies the inputs, and the build writes the new stamp after it succeeds.
Re-stamping alone cannot repair old compiler flags. The build directory must keep its original path.

Never copy a configured JSC build directory with `cp -a` to make a new prebuild. Its CMake cache
and `build.ninja` retain absolute paths to the original directory, so a copied build reconfigures
and writes into the original. Configure a fresh `JSC_BUILD_DIR` instead. This takes about 20 minutes
on a workstation. Reusing a WebKit source checkout is fine after resetting it.

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
  64-bit builds, so it never shows there; `tests/fixtures/engine-esm-imports` covers it.

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

## bun-jsc.wasm: the runtime on JSC

`bun-jsc.wasm` is the same `bun` as `dist/bun.wasm`: bunwasm-cli built with
`--no-default-features --features engine-jsc,bun-transpiler,bun-build`. The runtime
(crates/bunwasm-runtime: module loader, event loop, natives, the 17k lines of JS polyfills) talks to
its engine through the `Engine` trait (`src/engine.rs`); `src/engine_jsc.rs` implements it on
`crates/bunwasm-jsc`, a library with:

- `src/sys.rs`: hand-written declarations for the part of the C API used.
- `cpp/helpers.cpp`: what the C API lacks, written against JSC internals and compiled with the
  jsc shell's exact flags (read from `compile_commands.json` by `build.rs`): a global object whose
  ES module loader calls back into the runtime per file (resolve, fetch = read + transpile,
  import.meta), script evaluation with a file name and first line, top-level `import()`, the VM
  lock, explicit microtask draining, promise state, Proxy target, Error detection, and Bun's
  async-context slot (AsyncLocalStorage across `await`).
- `build.rs`: links the JSC archives, ICU, the shim and libc++ (the binary's own build.rs adds
  wasi-sdk's `crt1-command.o`).

Engine specifics, handled in engine_jsc.rs and inspect.js:

- Values the runtime keeps outside the stack are `JSValueProtect`ed handles (`JsVal`).
- Natives are C API functions that all dispatch through one callback, keyed by function object.
- Typed arrays handed to JS are made with `new Uint8Array(n)`: arrays made by the C API
  (`JSObjectMakeTypedArray*`) read `.buffer` as undefined in this C-loop build (the getter itself
  works when called directly).
- JSC ignores `Error.prepareStackTrace`, so `err.stack` keeps JSC's `name@file:line:col` format;
  inspect.js parses it, maps positions through the transpiler's source map, and moves call
  positions from the open paren to the callee, so printed errors match native Bun.

### One libc

The JSC archives and wasi-sdk's libc++ are compiled against wasi-sdk's wasi-libc, but rustc's
`wasm32-wasip1` target links its own bundled (self-contained) wasi-libc. Two libcs in one link
resolve each symbol from whichever archive the linker meets first, mixing versions. So
`scripts/build-bun-jsc.sh` builds with `-C link-self-contained=no`, and `build.rs` adds what rustc
then leaves out: wasi-sdk's sysroot as the library search path (rustc's `-lc` resolves there),
its `crt1-command.o`, and `libc++`/`libc++abi` from the sysroot's `noeh` directory.
wasi-libc's mman/signal/getpid emulation libraries stay out: bunwasm-posix defines those
functions. The changed `RUSTFLAGS` would invalidate the shared cargo cache, so this build uses its
own target dir (`$JSC_BUILD_DIR/target`). CI keeps that directory physically separate
from the reusable JSC prebuild at `$RUNNER_TEMP/jsc/prebuild`, so cache restore cannot
overlay Cargo files onto WebKit or ICU outputs. The prebuild cache is keyed only by
its C++/sysroot/toolchain inputs and its stamp is checked on reuse; the private Cargo
cache adds the Rust and Cargo inputs that can affect the final guest. A Rust-only edit
therefore keeps the unchanged prebuild candidate, while a changed C++ or sysroot input
changes both identities and must rebuild or validate a fresh prebuild.

### Numbers

| | dist/bun.wasm (QuickJS) | dist/bun-jsc.wasm (JSC) |
|---|---|---|
| size | 8.9 MB | 42.7 MB (12.1 MB gzip) |
| fixtures (`scripts/test.sh [--engine jsc]`) | 61/61 | 61/61 |
| `tests/bench/micro.js` loop | 207 ms | 268 ms |
| regexp | 122 ms | 75 ms |
| json | 190 ms | 52 ms |
| alloc (GC churn) | 489 ms | 590 ms |
| startup (`console.log(1)`, compiled module cached) | ~55 ms | ~165 ms |

No JIT: tight loops are ~1.3x slower than QuickJS; RegExp (YARR interpreter) and JSON are
1.6x and 3.7x faster.

### Not done / engine-inherent

- `err.stack` read by user code keeps JSC's `name@file:line:col` format (printed errors are
  converted); the fork doesn't honour `Error.prepareStackTrace` without Bun's global object.
- Map/Set iterator entries aren't shown by `console.log` (QuickJS has a helper for that), and
  `process.memoryUsage()` reports linear-memory size for every field.
- The nextTick queue runs between microtask drains, not between individual promise jobs
  (JSC drains its queue in one call).
- VM teardown aborts in `AtomStringImpl::remove`; the binary never destroys its VM.

## CI Binaryen setup

The blocking native job installs the official Linux x86_64 Binaryen `version_133`
archive with `bun scripts/ci-binaryen.ts` before either JSC cache branch. The
installer checks SHA256 on both downloads and restored archives, then checks the
exact `wasm-opt` version and `--spill-pointers` support before adding its bin
directory to `GITHUB_PATH`. The installer owns the pin and participates in the
SDK, native and JSC cache keys. The existing finalization and both embedding
fixtures still run on one JSC guest build.

Archive and published checksum are from the
[official release](https://github.com/WebAssembly/binaryen/releases/tag/version_133).
Setup tests do not replace actual JSC execution. A CI-only change does not make an existing guest a new build.
