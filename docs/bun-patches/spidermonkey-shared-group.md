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
  collection, which finalizes dead buffers in the foreground, and tries once more. Growable
  buffers keep engine-owned storage. A borrowed header charges the zone only its own size.
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

## Original adapters

- `spidermonkey/build-shared-group.sh`, `spidermonkey/shared-group.ts`: the library producer. It
  reuses the split fetch, patch, overlay and configuration, adds the atomics flags and the group
  define, and requires the shared-pic sysroot. The checker requires atomics in every archive
  member, the region constructor, and exactly the five core symbols above as new requirements.
- `scripts/build-engine-spidermonkey-shared.sh`, `scripts/spidermonkey-side-core-receipt.ts`: the
  group side link and its initializer conversion. A group side imports the shared memory and does
  not export it.
- `crates/bunwasm-spidermonkey/cpp/engine.cpp`, `engine.h`, `build.rs`, `src/lib.rs`: the region
  view, the storage lookup that lets the core name a buffer's region, and wait permission.
- `crates/bunwasm-engine-spidermonkey/`: the shared region view, nested execution and stack base.
  The nested bridge in `crates/bunwasm-engine-quickjs/src/nested_bridge.rs` is reused unchanged
  through its `NestedEngine` alias.
- `crates/bunwasm-host/src/linked.rs`: the native loader admits a SpiderMonkey group pair.

## Limits

A group side has no linker stack symbols. Its native stack quota is 7 MiB below a local in the
outermost side frame, inside the 8 MiB member stack the host carves.

The Rust standard library's errno reads are wrapped as in the QuickJS side (`group-errno.c`).
SpiderMonkey's C++ reads the side's own errno, so a core libc failure it inspects reports zero.

The interpreter and portable-baseline tiers use the same program bytes and are qualified
separately. Neither result stands in for the other.
