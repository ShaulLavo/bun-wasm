# JSC shared-group program

Classification: Port of upstream source, plus original build and engine adapters.

## Upstream

- Bun's WebKit fork at `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`, through `jsc/webkit-wasi.patch`.
- ICU 78.3, unchanged source, built with the group flags.
- LLVM `895aa2c896ada719451be2e3673c83da8ddf1141` `libcxx` and `libcxxabi`, the revision wasi-sdk 34.0
  ships, with that SDK's `llvm-pr-186054` and `llvm-undo-part-of-194317` patches from wasi-sdk
  `5a0bf653a1a06e1c18867567c5937006d3394a69`. No LLVM source is copied into this repository.

## Local changes

Every WebKit hunk below is gated on `BUN_WASM_SHARED_GROUP`. Split builds compile the original code.

- `Source/JavaScriptCore/runtime/AtomicsObject.cpp`: `Atomics.wait` and `Atomics.notify` on any
  SharedArrayBuffer use the group futex the core exports (`bun_futex_wait32`, `bun_futex_wait64`,
  `bun_futex_wake`), so a JS wait and nested Wasm wait share the one host queue. `Atomics.waitAsync`
  throws rather than keep a separate per-agent queue. Timeout, status and cancellation mapping match
  the QuickJS adapter. A cancelled member traps.
- `Source/WTF/wtf/StackBounds.cpp`: a group side has no `__stack_low` or `__stack_high`, because the host
  carves the member stack. The stack origin comes from a local in the outermost `jsc_run` frame,
  so the conservative scan covers every frame that can hold a value.

`jsc/build-libcxx.sh` rebuilds libc++ and libc++abi with the SDK's own configuration plus PIC and
atomics. The SDK's archives have no atomics, so `wasm-ld` refuses them under `--shared-memory`.
The build compares its `__config_site` byte for byte against the SDK header that JSC and ICU compile
with, and stops on a difference.

Cache completion binds the exact pinned patched LLVM tree, SDK configuration, effective tools,
sysroot headers and libc, profile flags and recipe. Both archive hashes and the ABI header must
match before reuse; stale or partial outputs fail rather than receive a new stamp. Resumed source
setup checks and completes each SDK patch, then rejects any other source changes.

## Original adapters

- `jsc/common.sh`, `jsc/configure.sh`, `jsc/build.sh`, `jsc/finalize.sh`, `jsc/build-icu.sh`,
  `scripts/build-jsc.sh`: the `JSC_PROFILE=shared-group` producer.
- `scripts/build-engine-jsc.sh`, `scripts/build-native-profile.ts`: the group side link.
- `crates/bunwasm-jsc/cpp/helpers.cpp`: real SharedArrayBuffer prefix views with
  `SharedArrayBufferContents::create` over the stable region, and JS `Atomics.wait` permission.
  Nothing is copied, and old prefix views stay live after growth.
- `crates/bunwasm-engine-jsc/src/vm.rs`, `lib.rs`: the shared region view, nested execution and
  stack origin. The bridge in `crates/bunwasm-engine-quickjs/src/nested_bridge.rs` is shared, named
  through a `NestedEngine` alias.

## Limits

The Rust standard library's errno reads are wrapped as in the QuickJS side (`group-errno.c`).
JSC and ICU C++ read the side's own errno, so a core libc failure they inspect reports zero.
They do not branch on that for shared-memory paths.

Single-agent results only. Cross-worker attachment is separate work. SpiderMonkey and Hermes have no
shared-group producer.
