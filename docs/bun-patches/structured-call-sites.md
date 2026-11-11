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
The experimental SpiderMonkey guest takes the same parsed path. Mozilla's
`js/src/vm/ErrorObject.cpp` at `a5df22d986d4b626f771b4f8885241941601c35c` supplies a
native `Error.captureStackTrace` that formats and attaches stack text immediately and
never consults `Error.prepareStackTrace`. Without the adapter, a package that installs
a formatter and reads the captured stack as CallSites receives a string. SpiderMonkey
names a suspended awaiting caller `async*<name>` where JavaScriptCore writes
`async <name>`; `isAsync` accepts both. No Mozilla source is copied or patched.
QuickJS's private native formatter collects raw CallSites. Its public formatter is
selected lazily by the Error prototype accessor or capture accessor. Successful
results, including non-string values, are memoized; formatter exceptions propagate
at access. A holder without a cached reentrant default permits a later read to retry.
No engine constructor is replaced.

Browser hosts probe native structured capture once before bootstrap installs the
standard formatter. `stack_capability.ts` installs a temporary marker formatter,
captures a holder and reads its stack while the hook is still installed, since V8
formats lazily. A finally block restores the original descriptor and any
accessor-backed formatter state. The same result selects bootstrap's V8 formatting
rules and the capture adapter. Browser JavaScriptCore uses the existing parsed
CallSites; Chromium keeps its native capture function and CallSite objects.
The source-only browser regression runs the bootstrap stack initialization and the
depd capture pattern in actual WebKit, Chromium and Firefox. It also checks lazy formatting,
error identity, constructor filtering, awaiting callers and native Chromium sites.
Firefox runs twice: as a browser host, and under the guest's `spidermonkey` engine
name, where the adapter meets the same native text capture as the SpiderMonkey guest.
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
| [`crates/bunwasm-runtime/src/js/stack_trace.ts`](#structured-call-sites) | Host feature | Original CallSite adapter for QuickJS, native or browser JSC and SpiderMonkey stack capture. |

| `crates/bunwasm-runtime/src/js/stack_capability.ts` and the stack initialization in `bootstrap.js` | Host feature | Original capability probe and shared formatter/capture selection. |

[Ledger scope and pinned revisions](scope.md).
