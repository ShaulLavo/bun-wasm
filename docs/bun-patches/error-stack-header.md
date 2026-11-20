# Error stack header

In Bun, `error.stack` starts with the error's `Name: message` line, then one
`    at …` line per frame. bun-wasm's default stacks held only frames on every engine,
and JavaScriptCore's held its own `name@file:line:column` text. The adapters below
are original bun-wasm code. They reproduce Bun 1.4.4's observed output and copy no
Bun, WebKit or V8 source.

| Source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/bootstrap.js`, `stackHeader` and `prepareStackTrace` | Host feature | Begin the default stack with the header and end it without a trailing newline. |
| `crates/bunwasm-runtime/src/js/stack_trace.ts`, `jscStack` and `jscFrameText` | Host feature | Rewrite JavaScriptCore's default text, at first access and after `Error.captureStackTrace`, as the header plus `    at` frames. |
| `crates/bunwasm-runtime/src/js/inspect.js`, `withoutHeader` and `frameText` | Host feature | Skip the header before parsing frames, and share the frame text of Bun's error printer. |
| `crates/bunwasm-runtime/src/js/console.ts`, `trace` | Host feature | Drop the header before the frames `console.trace` prints. |
| `crates/bunwasm-runtime/src/js/bootstrap.js`, `fallbackErrorText` | Host feature | Print the frames once under the fallback's label line. |
| `crates/bunwasm-runtime/src/modules.rs` and `natives.rs`, `sourceGeneration` | Host feature | Count changes to loaded sources and position maps, for the JSC frame cache. |

## The header

The header follows `ErrorInstance::sanitizedToString` in Bun's WebKit fork at
`3d3257150c40a1aabdc5f8b48d5b33d0413674cb` (`Source/JavaScriptCore/runtime/ErrorInstance.cpp`),
which Bun uses for its own stacks. It reads data properties only, so no getter or Proxy
trap runs: a Proxy prototype is skipped, as JavaScriptCore's inquiry skips it.

- The name is the error's own `name` or its prototype's, looking no further. A missing,
  `undefined` or object name reads `Error`, so `class X extends TypeError {}` prints
  `Error`, as in Bun.
- The message is the error's own `message`. A missing or object message reads empty.
- `name: message` joins them, or either one alone when the other is empty.
- `Error.captureStackTrace` on anything but an error writes `Error`.

QuickJS and the Browser engine read the header when they format a stack, at its first
read. JavaScriptCore reads it in the access-time callback of
[JSC access-time stack formatting](jsc-error-stack-materialization.md). A message
changed before the first read appears, one changed after does not, as in Bun.

## JavaScriptCore frames

`jscStack` parses each application frame with the inspector's existing parser, which
maps positions back through source maps and moves a call's column to its callee, and
prints it as Bun's error printer does. Native frames stay, printed as the QuickJS formatter
prints them; the runtime's own `bun-wasm:` frames are left out
([Runtime stack frames](runtime-stack-frames.md)). A frame with no source prints without a position: eval code as Bun's
`eval (unknown)`, a `new Function` body as `anonymous (unknown)`. Bun leaves the latter
out; it stays here because `callerSourceOrigin` reads it as an opaque caller.

Mapping a frame asks the host for its source map and source line, which made a 54-frame
read about 50 times slower than the native text. Formatted frames are cached by their raw
text. The cache empties when `sourceGeneration` moves: `crates/bunwasm-runtime/src/modules.rs`
bumps it whenever a loaded source or position map changes, including a file reloaded after
`delete require.cache[path]`. A hot run maps through changing revisions and skips the cache.
A hot run keeps the native text for the inspector, as QuickJS does. Custom
`Error.prepareStackTrace` formatters still receive CallSites parsed from the native
text. An empty trace stays without a stack property.

## Not covered

The experimental SpiderMonkey guest and a Browser engine running on a JavaScriptCore
host (Safari) keep their engine's own stack text: neither engine lets the runtime
rewrite a new error's stack. `tests/fixtures/error-stack-header` checks the header on
QuickJS, JavaScriptCore and the Browser engine against native Bun 1.4.4.

[Ledger scope and pinned revisions](scope.md).
