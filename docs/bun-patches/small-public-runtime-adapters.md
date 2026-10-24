## Small public runtime adapters

Class **Host feature**. `src/js/test_matchers.ts`, `web_brand.ts` and
`resolve_message.ts` are original bun-wasm implementations of public contracts.
The test adapter handles returned promises and tracks assertions through test
completion. An async `toThrow` returns a thenable; the runner waits for
unawaited checks before completing the invocation. Returned values use the
existing native promise brand and the engine reaction hook. QuickJS calls its
embedding `JS_PromiseThen` API. `crates/bunwasm-jsc/cpp/helpers.cpp` calls
`JSPromise::performPromiseThenExported` from WebKit's
`Source/JavaScriptCore/runtime/JSPromise.cpp` at the pinned revision above,
with a fresh intrinsic result promise,
matching Bun's direct reaction registration without inspecting public `then`,
`constructor` or species. These are original adapters to upstream embedding APIs,
not copies of their implementations.

The original browser adapter in `web/src/promise-reactions.ts` captures the
intrinsics at startup. It temporarily shadows a modifiable constructor with a
private data-only species object that returns the intrinsic Promise constructor,
attaches the original native reaction and restores the exact descriptor in
`finally`. No wrapper promise or extra reaction job is introduced. A private
species object also bypasses a patched intrinsic Promise species getter.
Ordinary frozen promises use the original operation after descriptor checks
prove their constructor and species are safe. Non-configurable writable data
constructors and existing configurable properties on non-extensible promises
remain modifiable and supported. The public `then` method retains ordinary
species behavior and async-context propagation. Native promise classification
also uses a captured intrinsic has-instance operation, bypassing a replaced
global Promise and patched public has-instance getters.

Immutable throwing constructor accessors, immutable unsafe constructor/species
combinations, and non-extensible promises with unsafe inherited constructors
cannot register safe reactions. They receive an explicit browser observation
error without executing the accessor. A fresh wrapper still resolves through
the original promise's public `then`; that method fails at the same immutable
constructor before marking the original rejection handled. Consequently an
already rejected original can still be unhandled in these documented cases.
The host's JavaScript promise brand also cannot recognize native promises whose
prototype chain no longer includes Promise.prototype. The fixture retains these
cases as browser-only TODO tests; QuickJS and JSC continue to execute them.
The pending observer retains the original native promise. It reads the existing
native promise state across engine checkpoints and uses native rejection events
to distinguish unhandled errors from caught rejections. Native engine and browser
host adapters preserve the original promise in the process rejection event.
The pending observer keeps original promises and never re-assimilates fulfilled
accessor values.
Web interface prototypes receive their standard `toStringTag`.
`Bun.version_with_sha` uses the existing embedded version and revision.

The resolver's module/package distinction follows `ResolveMessage::fmt` in
Bun's `src/jsc/ResolveMessage.rs` at the revision above. This small adapted
formatting rule distinguishes bare package names from specifiers containing a
slash. Structured error properties and package JSON notes are original adapters
around the local resolver and serde JSON parser. They retain diagnostic context
without changing upstream tests or snapshots. Package JSON EOF notes use Bun's
public wording; other JSON failures keep serde's diagnostic text.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Small public runtime adapters](#small-public-runtime-adapters) | Host feature | Original matcher, native and browser promise reaction, version, web-brand and resolver-diagnostic adapters. |

[Ledger scope and pinned revisions](scope.md).
