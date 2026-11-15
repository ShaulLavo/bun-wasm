# JSC and Browser CallSites

The embedding and Browser adapters are original. The WASI materialization port
is recorded separately in [JSC access-time stack formatting](jsc-error-stack-materialization.md).

| Source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-jsc/cpp/helpers.cpp`, `formatErrorStack` | Host feature | Connect access-time materialization to the runtime formatter. |
| `crates/bunwasm-runtime/src/js/stack_trace.ts` | Host feature | Register the JSC formatter and load the V8 CallSite adapter. |
| `crates/bunwasm-runtime/src/js/host_call_sites.ts` | Host feature | Adapt the frame predicates passed to custom V8 formatters. |

## JSC

The upstream API is WebKit `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`,
`Source/JavaScriptCore/runtime/VM.h` and `runtime/ErrorInstance.cpp`.
The WASI-only access-time callback runs after native text and location metadata
materialize, whether the weak frames are live, collected, or empty.

The callback looks up the runtime's formatter under a fixed global symbol.
Before bootstrap installs it, the callback returns native text. Afterwards,
`formatStack` handles custom results, source mapping and memoization. The
native materializer publishes its result before calling JavaScript, so a
formatter can read the same error without recursing. Error constructors stay native.

## Browser

V8's CallSite prototype methods are non-configurable and non-writable in the
tested Chromium and Node engines. The adapter wraps custom formatter functions
and passes proxies for their CallSites. Other methods bind to the original
frame, preserving V8 receiver checks and frame metadata. A program frame has no
function name and enclosing position 1:1 in a loader-registered module script.
The loader records the SHA-256 of its exact compiled ESM source. Its injected
import.meta prologue keeps user functions away from 1:1. The adapter compares
V8's script hash, rather than trusting a filename or a position alone. Other
scripts and evals, including anonymous awaiting functions at 1:1, keep their
native async flags. The name-based top-level predicate stays unchanged.
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
