### Inspection host hooks

`crates/bunwasm-runtime/src/js/inspect.js`, host integration around both formatters. Class **Host feature**. These are original bun-wasm additions around the Bun sources cited above, not another copied upstream file.

Read promise state/results, proxy targets, namespace brands, ordered keys, and remaining iterator entries through `internal` hooks. Use source-line lookup for error display. These hooks let an engine host expose information ordinary JavaScript cannot inspect reliably or without consuming an iterator. The QuickJS implementations are classified separately in the vendored-engine section.


The original stack parser adapter reads the engine and prepared-source lookup from `internal.native`, supplied by the bootstrap factory. Bind that object locally rather than reading an ambient `native` variable. Prepared browser frames still map through their generated filename without callee-column adjustment; ordinary JSC frames retain display-name mapping and callee columns. The source-only regression uses the retained 3cd/c276 Next dev failure stack and checks that error formatting preserves the original exception message.

The SpiderMonkey-specific parser uses the engine's native `name@file:line:column`
syntax. Native frames are dispatched before a V8 prefix check, because a valid
function display name can start with `at `. Text alone does not identify async
ancestry: a synchronous computed method can also be named `async*sync`.

The engine adapter installs a read-only internal symbol capability before the
runtime starts. The formatter captures that function once. It reads
`JS::ExceptionStackOrNull` and the supported SavedFrame APIs, stopping at metadata
async boundaries without interpreting function names. Name, source and position
stay separate through mapping. The reader only applies when the observed stack
matches the saved stack's native text; custom stack text retains ordinary parsing.
It neither reads a public stack getter again nor changes the error, rejection,
stack text or prototype. The capability stays in SpiderMonkey initialization;
no shared Engine ABI, other engine adapter or public Waffle interface changes.

Synchronous CommonJS wrappers keep their location but not their synthetic name.
After source mapping, a SpiderMonkey constructor column advances only for the
simple same-line `new` plus horizontal whitespace and identifier form. Comments,
multiline and unrecognized callee syntax retain the native position instead of
inventing a location in trivia. Other engines keep their existing column rules.

These are original host adapters. The checked contracts are Mozilla
`a5df22d986d4b626f771b4f8885241941601c35c`, `js/public/Stack.h`,
`js/public/SavedFrameAPI.h`, `js/public/Exception.h`, `js/src/vm/SavedStacks.cpp`,
and `js/src/vm/AsyncFunction.cpp`. Native `Error.stack` retains async ancestry.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/inspect.js`, host hooks](#inspection-host-hooks) | Host feature | Expose inspection state and bind stack source-mapping hooks from the factory input. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
