# Unhandled rejection queue and `rejectionHandled`

Class **Port**. How the runtime reports unhandled promise rejections follows Bun at revision
`9510e74152073d850a18758ca41114d8f214ffa6`. No Bun source is copied. The Rust, C++ and
JavaScript below reimplement these upstream pieces:

| Upstream | Behaviour reproduced | Where |
| --- | --- | --- |
| `src/jsc/bindings/RejectedPromiseQueue.h`, `RejectedPromiseQueue.cpp` | Rejections without a handler wait in rejection order. A first handler removes its entry at once (so the queue never keeps a handled promise alive), and handled entries are compacted away when they outnumber the rest. Adding, handling and taking cost O(1) amortized | `crates/bunwasm-engine-quickjs/src/rejection_queue.rs`, used by the QuickJS and JSC engines |
| `src/jsc/bindings/ZigGlobalObject.cpp` `GlobalObject::promiseRejectionTracker` | JSC's rejection tracker in the custom global object method table feeds the queue on `Reject` and removes the entry on `Handle`, instead of JSC's default batch at microtask exhaustion. `bunjsc_promise_mark_handled` tells the tracker too | `crates/bunwasm-jsc/cpp/helpers.cpp` `trackPromiseRejection`; `crates/bunwasm-engine-jsc/src/vm.rs` `bunjsc_host_rejection` |
| `ZigGlobalObject.cpp` `GlobalObject::handleRejectedPromises` | After the microtasks drain, rejections are taken and reported one at a time, so a listener that handles a later rejection keeps it from being reported. Rejections made by a listener are reported in the same pass | `crates/bunwasm-engine-quickjs/src/program.rs` `check_rejections` (QuickJS and JSC) |
| `RejectedPromiseQueue::markReported`, `didHandle`, `src/jsc/virtual_machine_exports.rs` `handle_handled_promise`, `src/jsc/bindings/BunProcess.cpp` `Bun__emitHandledPromiseEvent` | A promise reported to an `unhandledRejection` listener that later gets a handler emits `rejectionHandled` with the promise, once. One owed from before a pass comes before that pass's reports, as Bun's `HandledPromise` task and Node's `processPromiseRejections` run first; one owed by a listener of the pass comes after its reports. The reported set is a `WeakSet` | `crates/bunwasm-runtime/src/js/bootstrap.js` `handleRejection`, `handleRejectionHandled`; `program.rs` `check_rejections` |
| `src/jsc/modules/BunJSCModule.h` `heapStats` | `bun:jsc` `heapStats().objectTypeCounts` holds JSC's live cells per class name. Other engines report an empty object as before | `helpers.cpp` `bunjsc_object_type_counts`; `crates/bunwasm-runtime/src/js/builtins.js` |

The Browser engine runs on the page's own engine, which already re-checks each rejection before
its `unhandledrejection` event. `web/src/engine-host.js` now forwards the host's
`rejectionhandled` event (or a Node host's `rejectionHandled`) to `handleRejectionHandled`.
Node 26, the host `scripts/test.sh` and the suite runner use, reports every rejection of a turn
even when an earlier report's listener gave a later one a handler. On a Node host (not Bun's,
and never in a browser) the engine host turns on V8's init promise hook while the guest's
listeners run and skips the promises that got a handler then.

Hermes and SpiderMonkey keep their own lists; they now hand rejections over one at a time too,
but do not report late handlers.

## Differences from native Bun 1.4.4

- When a timer set after a top-level `await` handles a reported promise and rejects another,
  native Bun reports the new rejection before `rejectionHandled`. With the timer set from the
  module's synchronous code, Bun emits `rejectionHandled` first, and Node does so in both
  cases. bun-wasm always emits it first.
- On the Node test host the Browser engine follows Node's order when an `unhandledRejection`
  listener handles its own promise and rejects a new one: `rejectionHandled` comes before the
  new report. Bun, QuickJS, JSC and Chromium report the new rejection first.
- Bun emits a `PromiseRejectionHandledWarning` with `rejectionHandled` when
  `--unhandled-rejections` is set to a Node mode; bun-wasm has no such option, so it never does.

### Known differences that predate this change

- A throwing `unhandledRejection` listener ends the process on QuickJS and JSC ("uncaught error
  while reporting an error", exit 1). Bun passes each throw to `uncaughtException` and continues.
- A microtask queued inside an `unhandledRejection` listener runs only after the next timer.
- With several timers due at once, a rejection from the first is reported at a different point
  than in Bun, and `setImmediate` callbacks are ordered differently around rejection reports.

## Tests

The native fixtures `process-rejections-one-at-a-time`, `process-rejection-handled`,
`process-rejection-handled-order` and `process-rejections-many-handled` hold native Bun's output
and run on all three engines. `process-rejection-handled-own-listener` runs on QuickJS and JSC
(Node orders it differently, above). `process-rejection-queue-releases` counts live rejection
reasons with `heapStats` and runs on JSC. `rejection_queue.rs` has unit tests for order, removal
and compaction.

[Ledger scope and pinned revisions](scope.md).
