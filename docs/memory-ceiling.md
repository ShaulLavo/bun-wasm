# Bun's Wasm memory maximum

Bun core and its QuickJS or JavaScriptCore engine share one wasm32 linear memory.
Its maximum is 1 GiB, or 1073741824 bytes (16384 pages). It was 512 MiB until
stage 1 of the plan below.

## One authority

`crates/bunwasm-cli/max-memory.txt` holds the maximum as one line of decimal bytes.
It is the only copy. Everything else derives from it:

- the `--max-memory` link argument of `bun.wasm` (split and shared-group cores),
  `bun-build.wasm` and `bun-tools.wasm`, and the shared-group receipt's link list;
- the page maximum a shared-group core must declare, checked when the core is
  converted (`scripts/src/engine-explicit-init.ts`) and admitted by the native host
  (`crates/bunwasm-host/src/linked_group.rs`), and the Bun group's policy;
- the native host's Store memory limit for a guest whose Worker sets no
  `resourceLimits`;
- JSC's `forceRAMSize` (`crates/bunwasm-jsc/cpp/helpers.cpp`, which receives
  `BUN_WASM_MAX_MEMORY` from its build script), so JSC sizes its heap for the real
  maximum rather than wasi-libc's wrapped 4 GiB estimate;
- the jsc shell and the QuickJS linker test.

Rust reads the file in `crates/bunwasm-cli/max_memory.rs`, TypeScript in
`scripts/src/program-profile.ts`, and both accept only a page multiple in
(0, 2 GiB], bounding the number before each decimal digit so a long value cannot
wrap. Shell consumers get the value from `program-profile.ts max-memory` before
they configure or link anything. The file is part of every guest's source manifest and of the JSC
prebuild's input hash. `tests/package/max-memory.test.ts` fails if a consumer
gets its own number again. There is no environment variable or flag for it.
Changing capacity is a reviewed edit of that one file, one stage at a time.

## Why it was 512 MiB

Bun's `EncodedSlice` stored three flags in address bits 29, 30, and 31 on wasm32.
UTF-8, global allocation, and UTF-16 flags left only 29 address bits. An address
at or above 512 MiB could become a flag and decode to the wrong address. The cap
prevented that corruption.

Patch [0019](bun-patches/0019-wasm32-string-flags.md) implements design A.
On 32-bit targets, `EncodedSlice` stores the full pointer and a separate flags byte.
It grows from 8 to 12 bytes, and its containing `bun_core::String` grows from
12 to 16 bytes. Native64 keeps its existing layout and pointer flags.
All Rust users compile against the same definition. The wasm32 hosts exchange
addresses and bytes, not either string structure. Native C++ peers keep their
existing layout.

## What a maximum does not mean

The maximum is how far memory may grow, not what a guest starts with or uses.
Cores still start small. A larger maximum does not establish Next.js, SolidStart
or Vite acceptance, nor that a device can supply the memory. Waste and retention
fixes remain necessary regardless of capacity.

JSC's `forceRAMSize` doubled with stage 1, so JSC collects garbage later and its
peak memory can rise. That must be measured per engine.

Stock Rolldown 1.2.15 constructs
`new WebAssembly.Memory({ initial: 16384, maximum: 65536, shared: true })`:
1 GiB at construction, with no option to ask for less. Wherever that memory has
to live inside a Bun guest (a region of a Bun memory group, or the in-guest Wasm
interpreter on QuickJS and JSC), it needs those 16384 pages **plus** every Bun
member's own image, stack and heap. A 16384-page maximum cannot hold it.
**Stage 1 does not admit stock Rolldown inside a Bun guest; the 2 GiB stage
(32768 pages) is the first where it is even arithmetically possible,** and whether
it then fits beside its Bun members and workers is unmeasured. The browser engine's
native `WebAssembly.Memory` is outside this maximum.

## Stages

- **512 MiB, stage 0 (done):** the new representation. Actual-source tests
  (`scripts/check-encoded-slice.ts`) check layouts, constructors, substrings,
  truncation, lifetime detachment, and synthetic addresses through `0xffffffff`
  without dereferencing them.
- **1 GiB, stage 1 (this maximum):** one authority for every consumer, and the
  checks below.
- **2 GiB, stage 2:** repeat near the signed-address boundary with real
  allocations and each engine's safety and workflow checks. This is the first
  stage that could hold stock Rolldown's memory beside Bun.
- **Above 2 GiB, stage 3:** first normalize exported and imported i32 pointers to
  unsigned addresses in Waffle and bun-wasm's browser host. Waffle's fix must land
  before updating its dependency pin. Then check high-address I/O and host results
  and repeat the engine gates, up to wasm32's 4 GiB address space. Both readers
  refuse values above 2 GiB until then.

### Stage-1 checks

- `scripts/check-encoded-slice.ts` (blocking `rust` CI job) links its wasm32 probe
  of the actual `EncodedSlice` and `String` source at the maximum. It grows memory,
  places Latin-1, UTF-8 and UTF-16 bytes at and above `0x20000000`, decodes them
  through Bun's readers, and moves them through WASI `fd_write` and `fd_read` with
  iovecs, buffers and result cells above 512 MiB. It then checks that the top of
  the maximum is usable and one more page is not. Source from before patch 0019
  fails it, and so does a 512 MiB link.
- `tests/fixtures/strings-above-512mib` runs on the produced guests: QuickJS in
  the native fixture checks and JSC in `scripts/jsc-embedding.ts`, both blocking.
  It fills memory past 560 MiB with 16 MiB blocks, so later 17 MiB allocations
  come from above them. `bunStringRoundTrip` (`bun:internal-for-testing`) wraps
  such a copy in Bun's own `String`, decodes it through `EncodedSlice`, and
  reports the address; the fixture requires it at or above `2**29` with identical
  bytes for each encoding. Transpile and build outputs must also match a run
  without ballast.
- `tests/fixtures/gc-large-cyclic-garbage` passes 1.5 GiB of cyclic garbage
  through the 1 GiB guest, so it still requires collection.
- Not covered by CI: each engine's app, retention and memory gates, JSC's peak
  against the earlier 512 MiB runs, a real 16384-page shared-group pair, and
  device availability.

At every increase, record successful growth and allocation failures on desktop
browsers and iOS Safari. A synthetic pointer test does not establish device
availability. Rust's single-allocation limit and each engine's string and
ArrayBuffer limits also remain.

## The wasm64 alternative

Memory64 uses 64-bit addresses and could avoid wasm32's 4 GiB address space limit.
It is a separate port, not a linker setting. It requires checking Rust, the WASI
SDK and sysroot, QuickJS, JSC, the Wasm interpreter, and Waffle's host interfaces,
including BigInt addresses. Browser support, especially Safari on macOS and iOS,
toolchain readiness, and memory-heavy performance have not been established. No
wasm64 support or speed claim is made here.

For other constraints, see [Limits](limits.md).
