# SpiderMonkey engine program

This is an opt-in experimental engine, not a supported producer or release engine.
The Unicode subset and JSAPI adapter now run focused Bun fixtures in interpreter
and portable-baseline mode. The tiers use the same program bytes. They do not
provide hardware JIT. Explicit native, Node, and browser host loading is separate
from the unchanged QuickJS and JSC publication boundary. Full G3 and G4
qualification remains outside this integration.

## Classification

| Source | Class | Origin and change |
| --- | --- | --- |
| `crates/bunwasm-spidermonkey/cpp/engine.cpp`, `engine.h` | Original adapter | Calls JSAPI from `mozilla-firefox/firefox@a5df22d986d4b626f771b4f8885241941601c35c`. It owns persistent value roots, module roots, the native microtask queue, async frames, external buffers, and native closure holders. Exported friend APIs from `jsfriendapi.h` and `js/friend/MicroTask.h` provide reserved native-function slots, proxy inspection, and the current microtask representation. No Mozilla implementation is copied. The G2 shim remains separate and unchanged. |
| `crates/bunwasm-engine-spidermonkey/` | Original adapter | The side entry follows this repository's Hermes and JSC registration entries at `d18ff6ce0fa48266d8e9811702c13ff99a6922cf`. Rooted values adapt the existing `Engine` and `ModuleHost` traits. Module loading calls SpiderMonkey's native ES module APIs, not Hermes's registration loader. The shared engine driver and host ABI are unchanged. |
| `crates/bunwasm-spidermonkey/build.rs`, `src/lib.rs` | Original adapter | Adds the engine C ABI and a production input directory. The existing `standalone` feature keeps the original G2 shim and its emulated libc libraries. The engine side imports libc from the common core instead. Both paths retain the existing single Rust standard library and the copied normalization glue recorded in `spidermonkey-g2.md`. |
| `spidermonkey/prepare-engine-inputs.ts` | Original adapter | Verifies the retained G1 and G2 receipts before copying the exact native archive and exported headers. The successor explicitly records a reused G2 build, not a new Mozilla build. The original roots, generated objects, source, configuration, and receipts are not modified. |
| `scripts/build-engine-spidermonkey.sh`, `scripts/build-bun-spidermonkey.sh` | Original adapter | Follows the existing Hermes split build recipes. It uses explicit initialization, build-std, core-owned allocation, import admission, and separate source and artifact receipts. It does not rebuild the SDK, sysroot, or Mozilla library. |
| `scripts/quickjs-core-exports.txt`, `crates/bunwasm-cli/build.rs` | Host feature | Adds the measured `getpid` import and links the existing WASI getpid emulation in the core. The production side otherwise reused G2's admitted libc list. This changes the common core for all engines. No stateful host import is added. |
| `crates/bunwasm-host/src/{linked.rs,main.rs,process/executables.rs,process/mod.rs}`, `src/engine-kind.ts`, `scripts/guest-{core,engine,build}-receipt.ts`, `scripts/guest-source-manifest.ts`, `scripts/test.sh` | Host feature | Adds the opt-in native paired kind, companion, initializers, executable paths, source-input group, and fixture selector. SpiderMonkey is rejected for the shared-group profile. Explicit browser registration is covered by `spidermonkey-host-plumbing.md`; the producer's selected engine set remains unchanged. |
| `scripts/side-import-delta.ts` | Original adapter | Renames the existing engine-neutral `hermes-import-delta.ts` without changing its checks. Existing callers and the existing test owner follow the new path. |
