## Timer promise cancellation

Class **Host feature**. These are original adapters for the public
`node:timers/promises` contract. No upstream implementation is copied.
Comparison APIs are Bun `src/js/node/timers.promises.ts` at the Bun pin
`9510e74152073d850a18758ca41114d8f214ffa6` and Node `lib/timers/promises.js`.
Executable reference checks use native Bun 1.4.4 and Node 26.12.1.

The small timer factory in `builtins.js` loads `timer_promises.ts`. Every wait
owns its handle and named abort listener, and removes both on settlement.
Interval waits pass through `signal` and `ref`. Closing an iterator resolves
its private wait without yielding another value, so `return`, `throw`, and
`for await` break cannot retain a delay or abort listener. Queued `next` calls
are serialized before entering the generator. QuickJS-ng bundled with
rquickjs-sys 0.13.0 can leave requests pending behind a completed generator,
so only one request enters it at a time. The timer is still cancelled
synchronously when closing, including with multiple queued reads. Scheduling
remains with the existing runtime timers; event-loop behavior and `Timeout.refresh` are unchanged.

Unlike native async generators, an explicit `return` or `throw` during a pending
wait cancels that wait immediately instead of waiting for one last timer value.
This is an intentional cancellation guarantee of this adapter. It does not
change interval timing or add a new timer scheduler.

| Local source | Class | Provenance and reason |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/builtins.js`, timer promise factory | Host feature | Original module wiring limited to the existing timer factory. |
| `crates/bunwasm-runtime/src/js/timer_promises.ts`, `timer_promises_types.d.ts` | Host feature | Original promise and iterator lifecycle implementation and erased timer contract. |
| `scripts/timer-promises.test.ts`, `checks/runtime-timer-promises.json` | Host feature | Original factory-level regressions for success, abort, pending close, listener cleanup, and reference forwarding. |
| `tests/fixtures/timer-promises/`, `checks/native-timer-promises.json` | Host feature | Original portable native-reference and compiled-guest lifecycle fixture. |
| `tests/fixtures/timer-promises-unref/`, `checks/native-timer-promises-unref.json` | Host feature | Original process-exit fixture for unreferenced timer promises and intervals. |
| `tests/fixtures/timer-promises-pending-close/`, `checks/native-timer-promises-pending-close.json` | Host feature | Original guest contract for immediate pending-return/throw cancellation, with manually maintained output because native generators defer closing. |
