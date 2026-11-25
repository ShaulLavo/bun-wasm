# A portable backend for Bun's Rust host functions

The first slice compiles Bun's 71-line [SemverObject.rs](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/src/semver_jsc/SemverObject.rs) unchanged against a small
`bun_jsc` facade. Its public `Bun.semver.order` and `Bun.semver.satisfies` functions
come from that module. The same module also supplies
`bun:internal-for-testing.semverIntersects`.

Since Bun 1.4.5, `order` and `satisfies` are plain functions over UTF-8 bytes. Bun
generates their JavaScript entry points from `SemverObject.bind.ts`. Here
`crates/bunwasm-semver/src/lib.rs` holds that glue: it reads two string arguments
and returns the boolean or int32. `intersects_for_testing` is still a host function.

This is a source-compatible subset for one module. It is not a drop-in replacement
for the whole `bun_jsc` crate. In particular, it does not expose an engine heap or
claim to run `bun_runtime` as a complete crate.

## Facade design

The call follows the existing data-native path:

```text
Bun.semver JavaScript wrapper
  -> string coercion in the user's engine
  -> native.semverOrder / semverSatisfies / semverIntersects
  -> Val strings
  -> our call-scoped JSGlobalObject and CallFrame
  -> UTF-8 bytes (and a JsHeap for `order`'s error)
  -> unchanged Bun SemverObject.rs function
  -> boolean or int32, or JsError
  -> Val / NativeError
  -> JavaScript result or exception
```

QuickJS and JSC use the generic `data_fn<E: Engine>` adapter in
`engine_natives.rs`. It converts arguments with `Engine::to_val` and returns through
`Engine::from_val` or `Engine::error_value`. No engine-specific branch was added.
The browser's `engine_host.rs` does **not** implement `Engine` today. It serializes
the same `Val` calls across the wasm host boundary. This slice works through that
interface because all its arguments and results are plain data.

`crates/bunwasm-semver` selects the real upstream file with `#[path]`. Its dependency
named `bun_jsc` is a Cargo alias for our `bunwasm-bun-jsc` package. This is a local
manifest and source-selection override, not a patch to the shared vendor tree.
Adding `[patch.crates-io]` would not replace Bun's workspace path dependency.
The original `bun_semver_jsc` manifest and the rest of `bun_runtime` stay outside
this selected dependency graph.

The facade's `JSValue` is a `Copy` enum containing an immediate boolean, an int32,
undefined, or a slot index. A `JSGlobalObject` owns that call's string slots.
Slot values never leave the adapter call. There is no pointer tagging,
transmute, engine heap address, C++ ABI, or garbage collector integration.
Byte views own their bytes. This makes the original borrowing calls safe
for this slice, at the cost of extra allocations.

The facade's `bindgen` module has the two names the plain functions use.
`JsHeap` stands in for the engine heap Bun passes to a function that creates an
error; its `error` builds the message. `bindgen::Error` carries that error or an
allocation failure back to the glue, which turns it into a `JsError`.

The free-function `host_fn` macro keeps the function body and emits the
`__jsc_host_*` function pointer that Bun's source expects. It does not generate a
native JSC thunk. Methods and getter attributes fail compilation instead of
silently producing an invalid ABI. `bunwasm_semver::functions` lists the three
functions, which the runtime adapter uses to register natives.

JavaScript retains the argument-count checks and template-string coercion, with
an explicit canonical TypeError for Symbol primitives. Custom `toString` methods and their exceptions run in the
actual engine before the data boundary. The facade accepts string slots only.
Its string-conversion method names do not promise general ECMAScript coercion for
arbitrary `JSValue`s. Direct calls with other values return a `TypeError`.
This restriction is sufficient for the chosen wrapper and must not be copied to
a future module that expects arbitrary engine values.

The upstream suite also replaces global `gc` with a wrapper around `Bun.gc`.
The host engine now captures its original GC function at module initialization,
like its existing timer hooks. This prevents recursion into user code. Forced
host collection remains available only when the host exposes a GC function.

## API inventory and coverage

The pinned upstream revision is `a7733435cf40429e3b35c36072769df2052b80f1` (Bun 1.4.5).
The locally patched vendor HEAD is `2b7d8ba665744fa92e79a3039fc7bf32eed8d4a8`.
The selected semver file is identical at both revisions.

[bun-jsc-inventory.json](bun-jsc-inventory.json) records the complete lexical
inventory, including all sibling Rust crates with a direct `bun_jsc` dependency.
Regenerate it with `python3 scripts/bun-jsc-inventory.py --output docs/bun-jsc-inventory.json`.
The script excludes comments, string literals, and import declarations from usage
counts, and follows named imports and the `jsc` alias. It does not resolve Rust
types, macro expansions, wildcard imports, extension-trait calls, or shadowing.
It includes every source cfg branch, rather than only the active wasm target.
These counts rank source dependencies. They are not a count of methods to implement.
The focused check compares the counts and the selected semver source's SHA256.
Vendor commit IDs are informational because replaying the patch series creates
new commits even when the selected source bytes are identical.

| Scope | Rust files | Files using `bun_jsc` | Import bindings | Lexical references |
| --- | ---: | ---: | ---: | ---: |
| `src/runtime` | 470 | 299 | 1,663 | 16,242 |
| Runtime plus 11 sibling crates | 555 | 362 | 2,011 | 17,639 |
| `src/semver_jsc` | 4 | 1 | 6 | 9 |

The runtime inventory has 332 distinct imported or directly qualified names.
The most common are shown below. Different import paths for the same export can
remain separate rows.

| API name | Import bindings | Lexical references |
| --- | ---: | ---: |
| `JSValue` | 205 | 4,694 |
| `JSGlobalObject` | 207 | 2,187 |
| `JsResult` | 184 | 1,795 |
| `JsCell` | 52 | 766 |
| `CallFrame` | 117 | 684 |
| `host_fn` | 2 | 541 |
| `virtual_machine::VirtualMachine` | 68 | 384 |
| `JSType` | 13 | 285 |
| `ErrorCode` | 12 | 232 |
| `JsError` | 23 | 196 |
| `JsThread` | 4 | 192 |
| `webcore_types::Blob` | 1 | 175 |
| `resolved_source::Tag` | 10 | 166 |
| `bun_string_jsc` | 47 | 141 |
| `bindgen::JsLocal` | 27 | 107 |
| `JSPromise` | 17 | 105 |
| `JSPromiseStrong` | 7 | 105 |

The selected module needs the following subset. Occurrences are direct calls or
attributes in the unchanged file, not expanded code.

| Supported API | Occurrences | Implementation |
| --- | ---: | --- |
| `host_fn` | 1 | Safe Rust function-pointer alias |
| `bindgen::JsHeap`, `JsHeap::error` | 1 each | Stand-in heap that builds an error message |
| `bindgen::Result`, `bindgen::Error` | 2 return types | Error message or allocation failure, converted to `JsError` |
| `CallFrame::argument` | 2 | Undefined for a missing argument |
| `JSValue::to_utf8` | 2 | Owned UTF-8 bytes |
| `Utf8Bytes` deref | 6 | Byte slice access |
| `JSValue::js_boolean` | 1 | Immediate boolean |
| `JSGlobalObject::throw_out_of_memory` | 1 | Explicit error, with no claimed recovery from Rust allocation abort |

## What the remaining runtime needs

Ordinary property access, function calls, and exception propagation can use the
existing `Engine` operations once the facade owns real rooted `Engine::Value`
handles. The current call-local slots are deliberately insufficient for that.
`Strong`, `JsRef`, generated classes, finalizers, and callback storage need a
per-engine root arena with explicit ownership, reentrancy, and teardown rules.
`Copy` upstream values cannot directly own our reference-counted engine handles.

Typed arrays need borrowed byte access and detach semantics, rather than copies
through `Val::Bytes`. Promises need creation and resolver handles, callback
registration, and integration with the host job queue. Bun's `VirtualMachine`
also owns runtime services, not merely a JavaScript engine. Mapping its name to
`Engine` would hide filesystem, timers, event-loop, and worker responsibilities.
Those services need separate adapters.

The browser is an additional design constraint. Its current serialized interface
cannot represent object identity, closures, cycles, promises, or an arbitrary
UTF-16 string containing unpaired surrogates. A general facade needs host value
IDs and a reentrant host-call protocol, or an actual host `Engine` implementation.
Changing only the Rust facade cannot provide those operations.

This source selection bypasses the platform branches that stop `bun_jsc` and
`bun_runtime` from type-checking. Large modules still need both platform work and
the missing value operations.

Remaining work groups for a further port, each with its exit check:

- More string and scalar host modules: unchanged source, all-engine fixtures, upstream before/after counts.
- Rooted values, arbitrary objects, host reentrancy: identity, nested exceptions, GC stress and disposal tests on all engines.
- Classes, typed arrays, promises, runtime services: one real async filesystem or Blob path, no value or buffer leaks.
- Remaining `bun_runtime`: reach whole-crate compilation, then inventory unresolved runtime services.

## What cannot preserve JSC semantics elsewhere

JSC's tagged value bits, cell layouts, `JSType` classifications, VM pointers,
write barriers, and private class layouts are JSC implementation details.
QuickJS and the browser's engine cannot expose those same internals. Source that
reads them needs an engine-independent semantic operation or stays JSC-only.

DOMJIT fast paths, JSC bytecode, the JSC inspector, sampling-profiler data, and
JSC-specific heap and allocation counters cannot be implemented faithfully by
wrapping generic values. An empty or invented result would conceal the missing
capability. These should remain explicit engine capabilities.

N-API and FFI code that invokes native machine code also needs a separate WASI
or host implementation. Rust facade names cannot make native addons executable
inside wasm. Shared-memory workers and unrestricted browser sockets remain
platform limitations regardless of which JavaScript engine supplies values.

## Verification and size

Run the focused probe after building all three artifacts:

```sh
source env.sh
bash scripts/test-bun-jsc-backend.sh
```

The fixture covers valid and invalid versions, prereleases, build metadata,
Unicode, intersections, argument counts, coercion order, thrown-object identity,
and 500 consecutive calls. A separate fixture replaces global `gc` with a user
wrapper and verifies that `Bun.gc` still calls the captured host capability.
`scripts/test.sh`, `scripts/test.sh --engine jsc` and `scripts/test.sh --engine browser`
each pass 89 fixtures with 0 failures.

The optimized artifacts are `bun.wasm` (QuickJS) at 10,867,162 bytes,
`bun-jsc.wasm` at 46,232,098 bytes, and `bun-browser.wasm` at 10,144,959 bytes.
No speed claim is made. Measure the string copies before using this design for
large buffers.

The targeted upstream selection is `cli/install/semver.test.ts` and
`regression/issue/08040.test.ts`, run through `scripts/bun-suite.sh` with
`--network loopback --jobs 1` and the pinned supplemental dependencies. QuickJS,
JSC and the browser host each pass 346 tests, fail 5, and time out on none. The five
failures are package-manager cases: `--lockfile-only`, `bun pm version`, and the
diagnostic for an invalid range when the package exists.

## Next step

Proceed module by module for host functions whose inputs and outputs are plain
data, keeping the source unchanged where possible. Wholesale replacement of
`bun_jsc` over today's `Engine` trait is out of scope: the next design step is a
rooted-value adapter with a host-engine implementation and GC and reentrancy tests.

