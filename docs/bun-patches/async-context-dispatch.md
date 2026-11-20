# Async context of uncaught errors, stream sources and the loop's exit events

Class **Port**. No Bun source is copied. Where the runtime runs code that the program did not
call directly, it now uses the async context Bun uses there, at revision
`9510e74152073d850a18758ca41114d8f214ffa6`:

| Upstream | Behaviour reproduced | Where |
| --- | --- | --- |
| `src/jsc/VirtualMachine.rs` `uncaught_exception`, reached while the throwing callback's async context is still current | An `uncaughtException` handler (and the monitor and capture callback) reads the store the callback that threw was started in: a timer's, an immediate's, a tick's, an I/O callback's or an event emitted from one. The callback's own `run()` has unwound by then, so a store it entered is gone. When callbacks nest, the innermost one that the error escaped decides | `crates/bunwasm-runtime/src/js/bootstrap.js` `runInContext` (records the context an error escaped), `takeThrownContext`, `handleUncaught`. Under `bun test` the runner's own handler keeps its context, since it tells concurrent tests apart by that context; an error from a concurrent test's timer stays an error between tests, as in Bun |
| `src/jsc/bindings/webcore/streams/WebStreamsMisc.cpp` `StreamAsyncContextScope`, `JSReadableStream` `m_asyncContext`, the pull and cancel algorithms in `JSReadableStreamDefaultController.cpp` and `JSDirectStreamController.cpp` | A `ReadableStream` keeps the async context it was constructed in, and its source's `start`, `pull` and `cancel` run in it, with the source itself as `this`, whoever reads or cancels the stream. `type: "direct"` sources too | `crates/bunwasm-runtime/src/js/stream_context.ts` (the `ReadableStream` that the globals and `node:stream/web` expose is a `Proxy` whose `construct` reads the source's members once, in WebIDL's order, into a dictionary whose algorithms run in the construction context; the runtime's own streams use the class from `streams.ts` directly) |
| `src/jsc/VirtualMachine.rs` `on_before_exit`, `on_exit` | The loop's own `beforeExit` and `exit` events run outside every async context, so an `enterWith()` that the entry module or a callback left behind does not reach them. `process.exit()` called by the program keeps the caller's context | `bootstrap.js` `outsideContext`, `emitBeforeExit`, `beforeExit` |

## Differences from native Bun 1.4.4

- The Browser engine uses its host's `ReadableStream`, which has no `type: "direct"`; direct
  sources therefore exist only on QuickJS and JSC.
- `ReadableStream` is a `Proxy` of the polyfill's (or the host's) class, and its prototype's
  `constructor` points at it. Instances, prototypes, `instanceof` and subclassing are
  unchanged; only the class the polyfill uses inside has another identity.

## Tests

The native fixtures `async-context-uncaught-store` and `async-context-stream-source` (all three
engines) and `async-context-direct-stream` (QuickJS and JSC) hold native Bun's output.

[Ledger scope and pinned revisions](scope.md).
