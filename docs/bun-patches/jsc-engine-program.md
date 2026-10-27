# JSC engine program

This is a source integration record based on bun-wasm
`a145d02013c5020888c7ef63910f63636c52cc64`. It does not establish a real
JSC pair, native PIC closure, or runtime admission.

## Classification

| Source | Class | Origin and change |
| --- | --- | --- |
| `crates/bunwasm-engine-jsc/src/vm.rs` | Port | Exact move of this repository's original `crates/bunwasm-runtime/src/engine_jsc.rs` at the baseline above. No upstream implementation copied. |
| `crates/bunwasm-engine-jsc/src/lib.rs`, `Cargo.toml` | Port | Original registration and entry adapter compiling the QuickJS-owned generic program sources with the JSC VM. |
| `crates/bunwasm-engine-quickjs/src/{driver,allocator,transport,client}.rs` and shared `program.rs`, `loader.rs`, `natives.rs`, `value_natives.rs` | Port | Existing repository algorithms at the baseline, with a generic driver and extracted core-backed allocation and transport storage. Both engine crates compile one source implementation. |
| `crates/bunwasm-runtime/src/{engine,data,ops,split_api}.rs` | Port | Existing engine and plain-data contracts included by the side. Core retains process state and services without a VM dependency. No VM values cross the transport. |
| `crates/bunwasm-host/src/linked.rs`, `src/engine-kind.ts`, `src/quickjs-program.ts`, consumer and receipt adapters | Host feature | Original engine declaration, fixed companion profile, paired byte identity, and pre-entry admission adapters. No parser or upstream loader implementation copied. |

## Adapter and upstream boundaries

The moved VM adapter calls the C API declared in
`crates/bunwasm-jsc/src/sys.rs` and the existing original wrappers in
`crates/bunwasm-jsc/src/lib.rs` and `cpp/helpers.cpp`. Their upstream API and
private-header reference is Bun's WebKit fork at
`3d3257150c40a1aabdc5f8b48d5b33d0413674cb`, under
`Source/JavaScriptCore/API/`, `runtime/`, `heap/`, and `interpreter/`.
These bindings and helpers are adapters to those APIs, not copied WebKit
implementations. This extraction changes their build ownership, not their
C API, private-header behavior, or upstream pin. Existing WebKit patch provenance
remains in [the patch series](bun-patch-series.md),
[interruption](engine-interruption.md), and
[finalizer dispatch](jsc-finalizer-dispatch.md).

The shared driver retains one event loop. The JSC side owns its context,
protected values, roots, callbacks, module handoffs, and pending jobs for the
whole process. The runtime's direct-State JSC runner is removed. No new common
rlib, second runtime instance, VM destructor, or context reset is introduced.
The existing runtime host API remains version 2.

The [shared producer record](quickjs-shared-module.md#shared-producer-source)
owns the converter and core producer provenance. The
[JSC recipe record](jsc-prebuild-inputs.md#jsc-program-recipes) owns native PIC
flags, the existing helper, and the JSC producer. Those original adapters do
not duplicate WebKit source. Engine input compatibility retains the full
workspace `Cargo.lock` conservatively; it does not narrow the lock graph.

## Source contract and delivery limits

`bun-wasm-engine` is authoritative. Paired cores require exactly one exact
`quickjs` or `jsc` tag and a bind function. Missing tags have no fallback.
JSC's pair is `bun-jsc.wasm` plus `jsc-engine.wasm`; the existing prebuild shell
is a different artifact. The async `engineLinkPlan` accepts paired files only,
snapshots the bytes, and uses the selected fixed initializer profile.
Receipts bind core and side byte identities to engine origin and compatible
current inputs. One common core is compiled and optimized before decoration
in the source recipe. Captured-command controls do not prove that production
execution has occurred.

The current generated default descriptor is `null`. A qualified default or an
explicit owner delivery decision is required before merge. No new artifact,
release tag, URL, or hash is supplied by this source checkpoint.

Real PIC/native C++ closure, process-clock members, shared stack and allocator,
constructors, pointer spilling, Binaryen finalization, GC, promises, callback
reentry, and native/Node/browser admission remain separate actual-pair gates.
The pre-existing `array_items` getter/allocation/GC rooting risk remains
unreproduced and unchanged. Source review and synthetic controls do not resolve
that risk or establish a real-pair pass.
