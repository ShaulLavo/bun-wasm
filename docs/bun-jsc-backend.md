# A portable backend for Bun's Rust host functions

The first slice compiles Bun's 126-line [SemverObject.rs](https://github.com/oven-sh/bun/blob/9510e74152073d850a18758ca41114d8f214ffa6/src/semver_jsc/SemverObject.rs) unchanged against a small
`bun_jsc` facade. Its public `Bun.semver.order` and `Bun.semver.satisfies` functions
replace our duplicate bridge. The same upstream module also supplies
`bun:internal-for-testing.semverIntersects`.

This is a source-compatible subset for one module. It is not a drop-in replacement
for the whole `bun_jsc` crate. In particular, it does not expose an engine heap or
claim to run `bun_runtime` as a complete crate.

## Why semver is the first slice

Bun's Rust runtime depends on `bun_semver_jsc` alongside `bun_sys_jsc`,
`bun_http_jsc`, and the other engine-facing crates. Its semver module makes a small,
useful first test of the host-function boundary. It reads a call frame, converts
strings, raises errors, returns values, and builds a function table. It needs no
sockets, native threads, async callbacks, or platform-specific filesystem state.
The upstream semver suite also has a seeded differential comparison with node-semver.

The alternatives are much larger than their names suggest. `node_fs.rs` has 10,116
lines, its binding module has another 527, and it depends on `VirtualMachine`,
async filesystem tasks, argument parsers, and return-value adapters. `Blob.rs` has
6,820 lines and owns streams, stores, generated classes, and ref-counted lifetimes.
Even the 207-line HTTP header adapter depends on JSC's `FetchHeaders` class.
Starting with these would test several unported systems at once.

Our old semver bridge already called Bun's real parser. This change additionally
uses Bun's real argument checks, parsing branches, error formatting, and result
selection. It does not newly port the semver algorithm.

## Facade design

The call follows the existing data-native path:

```text
Bun.semver JavaScript wrapper
  -> string coercion in the user's engine
  -> native.semverOrder / semverSatisfies / semverIntersects
  -> Val strings
  -> our call-scoped JSGlobalObject and CallFrame
  -> unchanged Bun SemverObject.rs host function
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
undefined, or a slot index. A `JSGlobalObject` owns that call's string and function
table slots. Slot values never leave the adapter call. There is no pointer tagging,
transmute, engine heap address, C++ ABI, or garbage collector integration.
Strings and views own their bytes. This makes the original borrowing calls safe
for this slice, at the cost of extra allocations.

The free-function `host_fn` macro keeps the function body and emits the
`__jsc_host_*` function pointer that Bun's source expects. It does not generate a
native JSC thunk. Methods and getter attributes fail compilation instead of
silently producing an invalid ABI. `create_host_function_object` records the
original function table, which the runtime adapter uses to register natives.

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

The pinned upstream revision is `9510e74152073d850a18758ca41114d8f214ffa6`.
The locally patched vendor HEAD is `4ceda2c2868d3a7703c7737ddd9de7244ec384df`.
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
| `src/runtime` | 440 | 287 | 1,611 | 17,684 |
| Runtime plus 11 sibling crates | 519 | 350 | 1,931 | 19,094 |
| `src/semver_jsc` | 2 | 1 | 4 | 29 |

The runtime inventory has 326 distinct imported or directly qualified names.
The most common are shown below. Different import paths for the same export can
remain separate rows.

| API name | Import bindings | Lexical references |
| --- | ---: | ---: |
| `JSValue` | 207 | 5,308 |
| `JSGlobalObject` | 213 | 2,589 |
| `JsResult` | 186 | 2,047 |
| `CallFrame` | 139 | 893 |
| `JsCell` | 52 | 772 |
| `host_fn` | 4 | 723 |
| `virtual_machine::VirtualMachine` | 63 | 363 |
| `JSType` | 13 | 305 |
| `ErrorCode` | 11 | 238 |
| `JsError` | 26 | 196 |
| `JsThread` | 3 | 192 |
| `bun_string_jsc` | 51 | 163 |
| `JSPromiseStrong` | 7 | 116 |
| `JSPromise` | 17 | 108 |
| `JsClass` | 23 | 81 |
| `ArrayBuffer` | 15 | 80 |
| `JsRef` | 19 | 77 |

The selected module needs the following subset. Occurrences are direct calls or
attributes in the unchanged file, not expanded code.

| Supported API | Occurrences | Implementation |
| --- | ---: | --- |
| `host_fn` | 3 | Safe Rust function-pointer aliases |
| `create_host_function_object` | 1 | Function table owned by the call context |
| `CallFrame::arguments`, `argument` | 2 each | Borrowed argument slice, undefined for a missing argument |
| `JSValue::to_js_string_view` | 4 | Owned view of a pre-coerced string slot |
| `JSValue::to_utf8` | 2 | Owned UTF-8 bytes |
| `JSStringView::to_utf8` | 4 | Owned UTF-8 bytes |
| `Utf8Bytes::slice`, deref | 19 slice calls | Byte slice access |
| `JSValue::FALSE`, `js_boolean` | 3 each | Immediate boolean |
| `JSValue::js_number_from_int32` | 5 | Immediate int32 |
| `JSGlobalObject::throw` | 4 | Error message returned through `NativeError` |
| `JSGlobalObject::throw_out_of_memory` | 2 | Explicit error, with no claimed recovery from Rust allocation abort |

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

An earlier spike on compiling Bun's real runtime found 23 prerequisite
compiler errors before either `bun_jsc` or `bun_runtime` type-checked. This spike
does not resolve those platform branches. It bypasses them by selecting a small
engine-facing source module with its own manifest. Large modules still need
both platform work and the missing value operations.

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

When this work was verified, the shared vendor checkout was missing already
committed Bun patch `0009`. All three initial full builds failed at
`dev_server/mod.rs:275` because `BundleV2::finish_wasi_dev_server` was absent.
Verification therefore used a private vendor worktree at the same pinned HEAD with
the existing patch applied. The semver source, tests, generated code, and
dependency inputs are unchanged, and no new vendor patch is introduced. The shared
checkout has since received patch `0009` (2026-10-16), so rebuilds from it need no
workaround.

Run the focused probe after building all three artifacts:

```sh
source env.sh
bash scripts/test-bun-jsc-backend.sh
```

The fixture covers valid and invalid versions, prereleases, build metadata,
Unicode, intersections, argument counts, coercion order, thrown-object identity,
and 500 consecutive calls. A separate fixture replaces global `gc` with a user
wrapper and verifies that `Bun.gc` still calls the captured host capability.
All three engine fixture gates pass with 89 passed
and 0 failed per engine, including this new fixture.

The optimized artifact sizes are:

| Artifact | Captured baseline bytes | Rebuilt bytes | Change |
| --- | ---: | ---: | ---: |
| `bun.wasm`, QuickJS | 10,859,284 | 10,867,162 | +7,878 |
| `bun-jsc.wasm` | 46,219,559 | 46,232,098 | +12,539 |
| `bun-browser.wasm` | 10,138,476 | 10,144,959 | +6,483 |

These are whole-artifact deltas against the captured pre-change binaries. They
include the facade, the intersection hook, the patch version bump, and resulting
link layout changes. The retained comparison results record the SHA256 of each
artifact. They do not isolate the size of each individual function.
No speed claim is made. Measure the string copies before using this design for
large buffers.

All required gates pass on this branch:

| Command | Result |
| --- | --- |
| `scripts/test.sh` | 89 passed, 0 failed |
| `scripts/test.sh --engine jsc` | 89 passed, 0 failed |
| `scripts/test.sh --engine browser` | 89 passed, 0 failed |
| `bash scripts/test-bun-jsc-backend.sh` | Two focused fixtures pass on every engine; inventory matches |
| `scripts/test-web.sh` | Type check, 16 unit tests, CLI networking, Chromium and WebKit checks pass |
| `cd site && bun install --frozen-lockfile && bun run build` | Pass |
| `node sandbox/tests/hmr-check.mjs <local site URL>` | All six browser/engine runs pass |

The targeted upstream selection is `cli/install/semver.test.ts` and
`regression/issue/08040.test.ts`, run through `scripts/bun-suite.sh` with
`--network loopback --jobs 1` and the pinned supplemental dependencies.
The suite revision, runner, dependency hashes, and 15-second file and 2-second
test limits match before and after.

| Engine | Before passing tests | After passing tests | After failing tests | Timeouts |
| --- | ---: | ---: | ---: | ---: |
| QuickJS | 1 | 346 | 5 | 0 |
| JSC | 1 | 346 | 5 | 0 |
| Browser host | 1 | 346 | 5 | 0 |

Before, the semver file fails to load because `semverIntersects` is missing.
The runner records that as one failure and one error, with no tests registered
from that file. After, it records 345 passing tests and five package-manager
failures there. The separate regression still contributes one passing test.
Fully passing files remain one of two. These are newly reachable passing cases,
not 345 independent bugs fixed by changing the parser.

The five remaining cases cover `--lockfile-only`, `bun pm version`, and the
diagnostic for an invalid range when the package exists. They fail on every
engine and were open when this was measured.

## Recommendation

Proceed module by module for host functions whose inputs and outputs are plain
data. Keep the source unchanged where possible and extend the facade only when
the next real module requires it. The unchanged semver bridge is a useful first
slice, and its internal intersection function removes a real upstream test blocker.

Do not attempt a wholesale replacement of `bun_jsc` over today's `Engine` trait.
The next design step is a rooted-value adapter with a host-engine
implementation and GC/reentrancy tests. Only after that works should this track
commit to async `node:fs` or `Bun.file`. Until then, track 1's JavaScript builtins
and bounded plain-data Rust modules give useful progress without pretending the
JSC memory model is portable.
