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
| `src/jsc/VirtualMachine.rs` `uncaught_exception`, `is_event_loop_alive`, `src/runtime/cli/run_command.rs` run loop | A throw from an `unhandledRejection` listener is an uncaught exception (origin `uncaughtException`): the monitor, capture callback and `uncaughtException` listeners see it with PR 951's exit codes, and the remaining rejections are still reported. One nothing claims is printed and counted. Bun's loop then stays alive only while immediates are queued, and an iteration that ran them still waits for the next timer. So the loop stops, skipping `beforeExit` and exiting 1, at the first point where nothing is due, unless immediates ran since the last such point; then it first waits for and runs the next timer. `runTimers` reports the stop as -2. A worker ends at once, as on its other fatal paths | `bootstrap.js` `handleRejection`, `reportListenerError`, `loopStopped`, `exitUnclaimed`; `program.rs` `run_event_loop` (QuickJS and JSC); `web/src/engine-host.js` `pump`, `finish` (Browser) |
| `src/jsc/event_loop.rs` `drain_microtasks` | The ticks and microtasks the listeners of a report pass queue run when the pass ends, then the rejections they made are reported, until both are empty, before the next immediate or timer | `program.rs` `check_rejections` (QuickJS and JSC) |
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

- After an unclaimed listener error Bun's own stopping point depends on where in its loop
  iteration the report ran: a rejection made by a timer is reported at the start of the next
  iteration, which still waits for the following timer. bun-wasm stops at the first point where
  nothing is due and no immediate ran, so it skips that timer. Bun also sets an exit code that
  was already set to 1 at the throw; bun-wasm leaves it until exit. Both exit 1.
- The Browser engine leaves this order to its host. Node, the test host, matches Bun. A browser
  page runs microtasks after each `unhandledrejection` event, so there a tick or microtask a
  listener queues runs before the next report instead of after the pass.

### Known differences that predate this change

- With several timers due at once, native Bun runs all of them before reporting a rejection
  made in the first; bun-wasm reports it after that timer's microtasks, before the next timer.
  `setImmediate` callbacks are ordered differently around rejection reports too. Matching it
  needs the loop to hold rejection reports until a timer phase ends, which belongs with the
  timer phase work in PR 966 (not yet merged).

## Tests

The native fixtures `process-rejections-one-at-a-time`, `process-rejection-handled`,
`process-rejection-handled-order` and `process-rejections-many-handled` hold native Bun's output
and run on all three engines. `process-rejection-handled-own-listener` runs on QuickJS and JSC
(Node orders it differently, above). `process-rejection-listener-throws` and
`process-rejection-listener-throws-stops` hold native Bun's output for throwing listeners, and
`process-rejection-listener-microtasks` for work the listeners queue; all three run on all three
engines.
`process-rejection-queue-releases` counts live rejection
reasons with `heapStats` and runs on JSC. `rejection_queue.rs` has unit tests for order, removal
and compaction.

[Ledger scope and pinned revisions](scope.md).
