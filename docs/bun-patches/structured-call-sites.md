## Structured call sites

`crates/bunwasm-runtime/src/js/stack_trace.ts` is an original adapter for the public
`Error.captureStackTrace` and `Error.prepareStackTrace` contracts. It does not copy
Bun, Node or WebKit source. QuickJS-ng at the vendored rquickjs-sys 0.13.0 revision
already supplies structured frames but omits queries used by stack-inspection
packages. The adapter extends that frame prototype. Bun's WebKit fork at
`3d3257150c40a1aabdc5f8b48d5b33d0413674cb` supplies captured stack text through
`Source/JavaScriptCore/runtime/ErrorConstructor.cpp`. The adapter parses those
frames through our existing inspector before invoking a custom capture formatter.
JSC captures raw frames immediately and selects the formatter only when the stack
is read. Parsed JSC CallSites carry already-mapped locations so their string and
getter forms use the same coordinates. Ordinary JSC Error construction stays native.
QuickJS's private native formatter collects raw CallSites. Its public formatter is
selected lazily by the Error prototype accessor or capture accessor. Successful
results, including non-string values, are memoized; formatter exceptions propagate
at access. A holder without a cached reentrant default permits a later read to retry.
No engine constructor is replaced.
The adapter is strict TypeScript. Erased annotations describe raw stack values, mapped
frames and the engine-owned accessors without changing executable statements.
Receiver and method metadata unavailable from these engines returns undefined or
null; eval-origin metadata is unavailable and returns undefined. Engine placeholders such
as `<input>` are not reported as source origins.
The regression fixture uses the public capture API without copying a package.

Successful stack values are memoized in an original WeakMap adapter, independently
of the holder's descriptor. Mutable holders may receive a data property;
frozen and sealed holders keep their accessor. Capture rejects non-extensible
or non-configurable targets before native capture mutates them, matching the
Node/V8 public contract. A single formatting guard covers all errors: reentrant
reads memoize the default stack, successful outer formatters may replace that
value, and throwing formatters clear the guard in finally. These are original
adapters derived from behavior probes, with no Node/V8 implementation copied.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/stack_trace.ts`](#structured-call-sites) | Host feature | Original CallSite adapter for QuickJS and JSC stack capture. |
