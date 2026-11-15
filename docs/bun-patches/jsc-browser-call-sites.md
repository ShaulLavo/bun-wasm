# JSC and Browser CallSites

These are original adapters. No upstream implementation is copied or patched.

| Source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-jsc/cpp/helpers.cpp`, `formatErrorStack` | Host feature | Connect JSC's existing lazy error callback to the runtime formatter. |
| `crates/bunwasm-runtime/src/js/stack_trace.ts` | Host feature | Register the JSC formatter and load the V8 CallSite adapter. |
| `crates/bunwasm-runtime/src/js/host_call_sites.ts` | Host feature | Adapt the frame predicates passed to custom V8 formatters. |

## JSC

The upstream API is WebKit `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`,
`Source/JavaScriptCore/runtime/VM.h`, `ErrorInfoFunctionJSValue` and
`setOnComputeErrorInfoJSValue`. `runtime/ErrorInstance.cpp` calls that callback
when it materializes an ordinary error. The adapter uses
`runtime/Error.h`, `getLineColumnAndSource`, and `interpreter/Interpreter.h`,
`stackTraceAsString`, to retain native text and location metadata.

The callback looks up the runtime's formatter under a fixed global symbol.
Before bootstrap installs it, the callback returns native text. Afterwards,
`formatStack` handles custom results, source mapping and memoization. The
callback publishes the raw stack before calling JavaScript so a formatter can
read the same error without recursing. Error constructors stay native.

## Browser

V8's CallSite prototype methods are non-configurable and non-writable in the
tested Chromium and Node engines. The adapter wraps custom formatter functions
and passes proxies for their CallSites. Other methods bind to the original
frame, preserving V8 receiver checks and frame metadata. A program frame has no
function name and enclosing position 1:1, using the bootstrap formatter's existing
classification. The existing name-based top-level predicate stays unchanged.
Only the program frame loses V8's async flag,
including a module suspended at top-level await. Anonymous awaiting functions
retain their native async flag and null function name. A host without enclosing
positions retains its native async flag.

The default formatter and native capture function stay unchanged. Custom hook
assignment uses an accessor and returns a stable wrapper for each hook.
Saving and restoring `Error.prepareStackTrace` preserves that wrapper. Code
that saves its descriptor must also save and restore the accessor's value.
The wrapper forwards the original receiver and error, preserves custom return
values and exceptions, and does not wrap a saved wrapper again.
