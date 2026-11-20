# Runtime stack frames

Bun's `error.stack` shows the program's frames and, where they take part, frames of Bun's
public JavaScript builtins such as `emit (node:events:…)`. Its native code never appears.
bun-wasm's runtime is JavaScript, so its event loop, module loader and Node modules printed
their own frames, for example `runMain (bun-wasm:bootstrap:…)` after every top-level frame and
`runInContext (bun-wasm:bootstrap:…)` under every timer callback. The adapters below are
original bun-wasm code. They reproduce Bun 1.4.4's observed output and copy no Bun, WebKit or
V8 source.

| Source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/bootstrap.js`, `hiddenCallSites`, `isSuspendedProgram` and `prepareStackTrace` | Host feature | Leave the runtime's frames out of the default text on QuickJS and the Browser engine. |
| `crates/bunwasm-runtime/src/js/stack_trace.ts`, `hiddenJscFrames` and `jscFrames` | Host feature | Leave them out of JavaScriptCore's rewritten text. |

## Which frames

- A runtime frame is one whose script is named `bun-wasm:…`: the polyfills, and on the
  Browser engine the host worker, which `displayName` already names `bun-wasm:host`.
- A native frame whose caller is a hidden frame goes too, such as the `apply` the event loop
  runs a callback through, or the `Promise` constructor called by the http server. A native
  frame called by the program, like `forEach`, stays.
- On the Browser engine in V8, the module suspended in a top-level await goes too. V8 lists it
  among a promise callback's async frames; JavaScriptCore does not, so Bun never prints it.
- Frames of Bun's own builtins (`bun-builtin:…`) stay: they are the frames Bun shows.

Native Bun prints its builtins' frames, such as `emit (node:events:97:22)` and
`processTicksAndRejections (native:7:39)`. bun-wasm implements most of those modules in its
own runtime, so it prints neither the frame nor a made-up replacement.

## What still sees them

- On QuickJS and the Browser engine, a custom `Error.prepareStackTrace` receives every
  CallSite, as Bun's formatters receive its builtins' frames. Caller-source-origin checks read
  those and skip the runtime's own. JavaScriptCore's CallSites, parsed from its text, already
  left the runtime's frames out.
- The uncaught-error printer, `bun test`'s failure output and the JavaScriptCore frame cache
  read the default text, which already skipped these frames when they parsed it.
- `BUN_WASM_INTERNAL_FRAMES=1` in the guest's environment keeps every frame, for debugging the
  runtime. It is read once, at the first formatted stack. `tests/fixtures/runtime-typescript`
  sets it to check the runtime's own source positions.

## Not covered

The experimental SpiderMonkey guest and a Browser engine running on a JavaScriptCore host
(Safari) keep their engine's own stack text, as in
[Error stack header](error-stack-header.md). `tests/fixtures/stack-runtime-frames` checks the
frames on QuickJS, JavaScriptCore and the Browser engine against native Bun 1.4.4: top-level
code, a function call, a CommonJS function, an EventEmitter listener, a timer, an immediate,
`process.nextTick`, a microtask, a promise callback, an fs callback, a stream pipeline, an
http server handler and two `bun test` tests.

[Ledger scope and pinned revisions](scope.md).
