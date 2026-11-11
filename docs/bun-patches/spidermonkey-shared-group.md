# SpiderMonkey shared-group library and side

Classification: Port of upstream source, plus original build and engine adapters.

This is an opt-in experimental engine profile, not a supported producer or release engine. It
covers the native launcher only. The Browser host still refuses a SpiderMonkey group pair.

## Upstream

- Mozilla `mozilla-firefox/firefox@a5df22d986d4b626f771b4f8885241941601c35c`, the same pin as the
  split library, through `spidermonkey/spidermonkey-shared-group.patch`. The patch applies on top
  of `spidermonkey/spidermonkey-wasi.patch` and touches none of the same files.
- LLVM `libcxx` and `libcxxabi` built with atomics by `jsc/build-libcxx.sh`, unchanged. See
  [the JSC record](jsc-shared-group.md) for its inputs.

## Local changes

Every hunk is gated on `BUN_WASM_SHARED_GROUP`. A split build compiles the original code, and the
split patch, recipe files and admitted split archive are not changed.

- `js/src/vm/SharedArrayObject.h`, `SharedArrayObject.cpp`: Mozilla's raw buffer header computes
  its data pointer from its own address, so it cannot describe storage it did not allocate. The
  header gains a stable region pointer with two modes. A borrowed header covers a prefix of a
  `WebAssembly.Memory` region and frees only itself. An owned header holds the region of one
  fixed-length `new SharedArrayBuffer()` from the core's `bun_shared_buffer_alloc`, and queues
  `bun_shared_buffer_release` when its last reference drops. A refused allocation runs one full
  collection, which finalizes dead buffers in the foreground, and tries once more. The
  constructor refuses a growable buffer with RangeError, because members could not share its
  length. A borrowed header charges the zone only its own size.
- Same files, `slice`: a species result over the source's own storage is detected by comparing
  storage pointers, because region views are distinct headers over one base.
- `js/public/SharedArrayBuffer.h`: `JS::NewSharedArrayBufferOverGroupRegion` creates the borrowed
  view. Nothing is copied, pinned or detached, and old prefix views stay live after growth.
- `js/src/builtin/AtomicsObject.cpp`: `Atomics.wait` and `Atomics.notify` use the group futex the
  core exports (`bun_futex_wait32`, `bun_futex_wait64`, `bun_futex_wake`), keyed by absolute
  address. A JS wait and a nested Wasm wait therefore share the one host queue, and prefix views of
  one region share one wait identity. The WASI build's own condition variable never blocks, so the
  original queue could only spin. Timeout, status and cancellation mapping match the QuickJS and
  JSC adapters, and a cancelled member traps. `Atomics.waitAsync` throws rather than keep a
  per-buffer queue no other member can reach.
- `js/src/jit/shared/AtomicOperations-feeling-lucky-gcc.h`: the portable header leaves 64-bit
  atomics off on 32-bit targets without a JIT, and a `BigInt64Array` operation then crashes the
  engine. An atomics build has native lock-free 64-bit operations, so the group build turns
  them on.

## Original adapters

- `spidermonkey/build-shared-group.sh`, `spidermonkey/shared-group.ts`: the library producer. It
  reuses the split fetch, patch, overlay and configuration, adds the atomics flags and the group
  define, and requires the shared-pic sysroot. The checker requires atomics in every archive
  member, the region constructor, and exactly the five core symbols above as new requirements.
- `scripts/build-engine-spidermonkey-shared.sh`, `scripts/spidermonkey-side-core-receipt.ts`: the
  group side link and its initializer conversion. A group side imports the shared memory and does
  not export it.
- `.github/workflows/ci.yml`: original CI environment adapter. The shared library producer runs
  from a fresh pip-free Python virtual environment. Mozilla's pinned `python/mach/mach/site.py`
  still uses `MACH_BUILD_PYTHON_NATIVE_PACKAGE_SOURCE=system` and runs its real package checks
  against the invoking environment and vendored packages. Unrelated runner tools stay outside
  that environment. No upstream Python source or dependency requirement changes.
- `crates/bunwasm-spidermonkey/cpp/engine.cpp`, `engine.h`, `build.rs`, `src/lib.rs`: the region
  view, the storage lookup that lets the core name a buffer's region, and wait permission.
- `crates/bunwasm-engine-spidermonkey/`: the shared region view, nested execution and stack base.
  The nested bridge in `crates/bunwasm-engine-quickjs/src/nested_bridge.rs` is reused unchanged
  through its `NestedEngine` alias.
- `crates/bunwasm-host/src/linked.rs`: the native loader admits a SpiderMonkey group pair.
- `scripts/ci-spidermonkey-prebuild.ts`: an original CI transfer adapter. The library recipe
  runs in a separate 30-minute prebuild job after the existing shared sysroot producer. It
  retains the recipe's Python isolation and upstream, command, object and header checks.
  Only `native/`, `receipt/` and a file manifest reach the existing SharedPIC owner. The
  manifest binds the run, checkout, recipe bytes, native tools, sysroot and transferred bytes.
  SharedPIC requires producer success, verifies the manifest, then links the side against its
  existing common core and atomics libc++. Every native and Browser consumer keeps its clock.
  The exact native cache has no prefix restore and saves only on successful main pushes.

## Limits

A group side has no linker stack symbols, and the host binds the carved stack bounds for the core
only. The native loader calls the side's initializers itself, after the core's constructors
return and before the core starts, so the stack pointer is still at the carved top there. The
side records the page boundary above a local of `spidermonkey_register` as the top, and the
bounds are that top and 8 MiB below it: the host's `STACK_BYTES` and the split core's linker
stack size. The native quota and its 64 KiB gap are therefore the split build's. A test pins the
three sizes and the loader's call order together. The engine refuses to start if its entry frame
is outside those bounds. A host that entered the initializers with other frames on the stack
would need its own bound source.

`BUN_WASM_SPIDERMONKEY_TRACE` in the guest environment prints one line on stderr when the engine
returns: the stack bounds, the stack in use at registration and at engine entry, the interrupt
polls, and the portable-baseline entries. The library calls the entry hook once per
portable-baseline interpreter entry and nowhere else, so a run with zero entries executed
entirely in the plain interpreter. The count costs one increment per entry. A process that ends
through `process.exit` prints nothing.

The Rust standard library's errno reads are wrapped as in the QuickJS side (`group-errno.c`).
SpiderMonkey's C++ reads the side's own errno, so a core libc failure it inspects reports zero.

The interpreter and portable-baseline tiers use the same program bytes and are qualified
separately. Neither result stands in for the other.
