## JSC prebuild inputs

Class **Host feature**, original build adapters in `jsc/common.sh` and
`scripts/jsc-inputs.test.ts`; no upstream source is copied or changed. WebKit stays
at `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`. The prebuild stamp fingerprints
effective compiler, SDK and include/link environment inputs rather than all of
`env.sh`, whose unrelated workstation scratch settings cannot change the engine.
Existing script, configuration, shim and tool-version fingerprints remain.
Staging compares configuration bytes before copying, preserving an unchanged
injected header's timestamp instead of recompiling every dependent C++ object.
Regression controls prove scratch-policy edits leave the stamp unchanged,
compiler/header changes invalidate it, and identical staged files keep their
timestamps. Stamp refresh still runs the normal incremental build; no check is
bypassed.


CI derives its prebuild key from this same stamp contract after the patched
sysroot has been verified. It does not hash unrelated lockfile or environment
file edits. Host compiler commands and versions, linker and SDK environment
variables also participate. A restored tree must retain its pinned WebKit commit,
tracked patch bytes and clean untracked state. Archive and shell hashes reject
partial or corrupted outputs. The existing WASI CMake preflight still verifies
compiler, SDK, toolchain and sysroot paths before reuse. Completed prebuilds are
saved before native quality checks, guest fixtures and assertions. Ordered Actions
steps trade cold-only overlap for a durable completed cache before a later timeout. The worker writes a fresh completion marker only after build and stamp validation.
The controller checks that marker before advertising cache readiness, even if a
shell reports a successful wait for a terminated worker. Missing proof never permits a save.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [JSC prebuild inputs](#jsc-prebuild-inputs) | Host feature | Original build-cache fingerprint, output integrity checks and early CI saves reuse only completed matching WebKit builds. |

[Ledger scope and pinned revisions](scope.md).

## JSC program recipes

[JSC engine program](jsc-engine-program.md) records the moved VM and shared
Rust driver provenance, and the remaining source-only delivery limits.

The original adapters in `jsc/configure.sh`, `jsc/build-icu.sh`,
`jsc/common.sh`, and `crates/bunwasm-jsc/build.rs` request PIC for WebKit's
static archives, ICU target code and generated data wrapper, the separate shim
members, and the private-header C++ helper. The helper discards the shell's
PIE and conflicting PIC flags before adding `-fPIC`. WebKit remains pinned to
`3d3257150c40a1aabdc5f8b48d5b33d0413674cb`; ICU remains 78.3. These recipe
changes copy no upstream implementation. Existing input fingerprints include
the changed recipes and reject native outputs built with the old flags.
The shell-required prebuild completion contract remains unchanged.

At this pinned WebKit revision, `Source/cmake/OptionsJSCOnly.cmake` sets
`CMAKE_POSITION_INDEPENDENT_CODE` to false when Bun additions are enabled.
The original configure adapter therefore also passes `-fPIC` explicitly in
both compiler flag strings. The CMake cache request alone does not establish
PIC; actual archive-target compile commands must contain the flag before the
prebuild is admitted to a shared-side link. This changes no upstream source
or pin.


`scripts/build-engine-jsc.sh` is an original program producer. It compiles the
JSC side with PIC Rust `std,panic_abort`, links against the existing native
closure, spills pointers on the module containing the VM, then converts its
implicit initializer with `scripts/src/engine-explicit-init.ts`. The fixed
exports are `jsc_initialize_memory`, `jsc_apply_data_relocs`, `jsc_call_ctors`,
`jsc_register`, and `jsc_run`. The constructor fixture in
`scripts/src/engine-init.c` retains its relocated data pointer and core-backed
allocation. The converter changes only start and export sections and checks
that every other byte stays unchanged. These helpers are original adapters
moved from the QuickJS fixture, not copied WebKit code.

`scripts/build-bun-jsc.sh` composes a verified optimized common core with
`jsc-engine.wasm`. A matching engine receipt permits reuse without compilation,
linking, or finalization. Reuse retains the original engine receipt; the current
pair receipt verifies current input compatibility and both final byte identities.
Missing, partial, or incompatible retained output fails instead of falling back.

PIC suitability of retained no-exception C++ and process-clock archive members,
actual unresolved imports, stack-bound binding, and Binaryen's shared-module
output remain real-link gates. The source recipe does not add JSC or C++
interpreter internals to core, supply stubs, or treat `--allow-undefined` as
acceptance. Parser and captured-command fixtures prove source contracts only.

| Source | Class | Change |
| --- | --- | --- |
| `jsc/configure.sh`, `jsc/build-icu.sh`, `jsc/common.sh`, `crates/bunwasm-jsc/build.rs` | Port | Original PIC build adapters for the unchanged pinned upstreams. |
| `scripts/build-engine-jsc.sh`, `scripts/build-bun-jsc.sh` | Host feature | Original separate-program producer and matched-pair composition. |
| `scripts/src/engine-explicit-init.ts`, `scripts/src/engine-init.c` | Port | Shared original initializer converter and constructor fixture. |

## Actual common-core export roots and weak native binding

The JSC side retains additional libc calls and the `stderr` and
`_CLOCK_REALTIME` data addresses. The original shared-core export adapter in
`scripts/quickjs-core-exports.txt` roots 66 existing implementations from the
selected patched wasi-libc and those two data definitions. They stay in the
single core libc/allocator; the side does not gain another libc or allocator.
The underlying source is wasi-libc `2e6fb9d8ee0cdf9e431fbcabe8af3115de000a13`,
with the existing Waffle preopen patch. A selected-libc probe verifies TLS,
mutex/condition timeout, semaphore count operations and the single-processor
profile; it does not establish concurrent thread lifecycle support.
`pthread_create`, `pthread_join` and `pthread_detach` are not exported as real
support. `Bun__reportUnhandledError` is also withheld: its upstream full Bun VM
implementation is not the engine-independent core's error dispatch contract.

Visible weak definitions are intentionally both imported and exported by
LLVM's shared Wasm linker. At the selected LLVM revision
`895aa2c896ada719451be2e3673c83da8ddf1141`, this is explicit in
`lld/wasm/Writer.cpp` (`shouldImport`) and `lld/wasm/Symbols.cpp`
(`Symbol::isExported`). A selected-toolchain fixture confirms `--undefined`
does not remove the weak import/export. This is linker semantics, not copied
product code. Actual archive definitions, code in the map, exported local
functions and typed imports must be distinguished; an import alone does not
prove missing native code. No whole-archive, symbol strengthening, hidden
visibility rewrite, dummy provider or weakened loader admission is introduced.

## WASI single-agent collection policy

The WebKit patch ports the existing inline collector at the same pinned
revision; it does not introduce a scheduler. `heap/Collector.cpp` retains its
normal idle take-conn and request/ticket protocol, with WASI invariants before
worker notification. `heap/Heap.cpp` advances bare async requests through the
existing safepoint, queues async requests from the active cycle without
recursion, rejects direct synchronous reentry, and rejects heap-access/conn
release with pending work or an unfinished phase transition. Notifications,
request coalescing, marking, epilogues and finalizers stay upstream.

The WASI branches of `WTF/wtf/posix/ThreadingPOSIX.cpp` fail closed for worker
create/join/detach instead of referencing unavailable pthread lifecycle calls.
The context adapter sets one marker, no block warm-up/concurrent GC or JIT,
polling traps and no optional profiler/continuous worker. This is a port of
selected WebKit platform behavior and an original configuration adapter.
The retained prepolicy fixture actually passed sync survivor/finalizer checks
then aborted on the unserved bare async request at API unlock. Post-policy
runtime proof and real-loader hello remain pending; these source conditions
are not an admission or general thread-support claim.
