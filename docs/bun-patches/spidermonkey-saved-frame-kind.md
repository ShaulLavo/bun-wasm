# SpiderMonkey SavedFrame frame kind

This port and host feature patches Mozilla revision
`a5df22d986d4b626f771b4f8885241941601c35c` through
`spidermonkey/spidermonkey-wasi.patch`. Capture discarded whether a nameless
frame was a JavaScript function or program body. Both can have identical names,
source and positions. The patch records the iterator's category at capture time.

| Upstream path | Local change and reason |
| --- | --- |
| `js/public/SavedFrameAPI.h` | Define Unknown, Program, Function and Wasm. Guard the native `GetSavedFrameKind` accessor with `__wasi__ && BUNWASM_EMBED`. It uses the same principal and self-hosted selection as other accessors. |
| `js/src/vm/SavedFrame.h` | Append one scalar reserved slot after all eight old slots; declare its getter and initializer. |
| `js/src/vm/SavedStacks.cpp` | Require kind in Lookup, hash and match it, initialize and copy it. Capture Wasm first, then `isFunctionFrame`, otherwise Program. Generic ubi reconstruction uses Unknown; live ubi retains its existing frame. |
| `js/src/vm/StructuredClone.cpp` | Initialize Unknown immediately after allocation. Existing wire bytes prove no category. |

The Int32 value needs no new traced edge, script owner or principal reference.
Existing rooting, GC, reentrancy, async traversal and principal flag bits stay
unchanged. Async copies preserve kind through Lookup. Source ID remains outside
interning identity. Unknown has a distinct identity from Program and Function.
The [source-kind patch](spidermonkey-saved-frame-source-kind.md) still owns source
provenance, principal masks and filename decoding.

The internal slot and identity apply outside embed builds too; only the accessor
is guarded. Eight slots become nine, rounded to twelve by the allocator. The
wasm32 object cell grows from 80 to 112 bytes, adding 32 bytes per distinct frame,
about 312.5 KiB for 10,000 frames before arena effects. This is a cell-layout cost,
not a process RSS measurement. Existing slot indices are unchanged.

## Original adapters

`cpp/engine.cpp` exports numeric kind only in the existing private SavedFrame
records. `inspect.js` derives an anonymous presentation flag from Function plus
an original null or empty name. `stack_trace.ts` passes that private flag to
`bootstrap.js` when printing a parsed CallSite. Diagnostic printing can then use
`<anonymous>` without changing true names or CallSite predicates. Named CommonJS
wrappers and the real name `anonymous` retain their existing behavior. QuickJS
keeps its generic CallSite `toString` and property descriptors.

## Controls

`tests/frame-kind-controls.cpp` runs in the ordinary engine-semantics driver on
both tiers. It tests both capture orders with equal old identity fields and null
parents, same-kind sharing, cell layout, script-private collection with retained
Errors, categories, async fast/full/truncated copies, reentrant capture,
self-hosted selection, clone Unknown and live/generic ubi reconstruction.
`filename-controls.cpp` retains its source-kind controls and adds frame-kind
checks across both muted states and source kinds with exact principals and
balanced holds. Null and denied frames return AccessDenied plus Unknown; a valid
reconstructed frame returns Ok plus Unknown. SavedFrame.prototype is invalid
input and is checked only with `IsSavedFrame`, never passed to the accessor.
The shipped native profile disables Wasm; no synthetic Wasm label proves capture.

Feature fixtures cover native kinds and custom CallSite string coercion on the
existing engines. Formatter tests retain mapping, sourceURL, NUL filename and
fallback behavior. The deliberately failing test goldens remain unchanged.
