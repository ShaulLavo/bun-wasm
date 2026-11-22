## `process.nextTick` microtask checkpoint and exception handling

Class **Host feature**, **original adapter** across QuickJS (`crates/bunwasm-engine-quickjs/src/vm.rs`), the shared JS runtime (`crates/bunwasm-runtime/src/js/bootstrap.js`, `crates/bunwasm-runtime/src/js/bun_test.js`), and the Browser host (`web/src/engine-host.js`). No upstream implementation is copied. The reference behavior is Bun's `process.nextTick` and `bun:test` turn model (`test/js/node/process/process-nexttick.test.js` at Bun `9510e74152073d850a18758ca41114d8f214ffa6`, checked against native Bun 1.4.4).

- `QuickJs::run_jobs()` drains all pending QuickJS jobs in a loop before returning to `Core::drain_jobs()`, matching the `Engine::run_jobs` trait contract and JSC's `bunjsc_drain_microtasks()`. Previously, executing one job per loop interleaved `process.nextTick` callbacks between microtasks queued in the same checkpoint.
- `processTicksAndRejections` (`bootstrap.js`) catches exceptions per tick callback and routes each through `reportCallbackError(err)`, rethrowing when `internal.exitStarted` or `native.isExecutionUnwind?.(err)` is set so host exits and execution unwinds propagate cleanly, and otherwise dispatching to `internal.handleUncaught(err)` (exiting with status 1 if unclaimed), so subsequent queued ticks continue to drain when an `uncaughtException` listener handles the error on every engine.
- `runTimers` (`bootstrap.js`) preserves end-of-batch yielding after a throwing immediate even when all remaining immediates in the batch were cancelled before running, so microtasks drain before due timers.
- `bun_test.js` runs each serial test's `beforeEach` hooks and body in the same scheduled macrotask turn via `internal.realTimers.setImmediate`, keeping synchronous hooks synchronous so the body stays ahead of immediates queued by `beforeEach` and synchronous `process.nextTick` calls run before promise continuations.
- `EngineHost` (`web/src/engine-host.js`) delegates tick scheduling to `web/src/tick-scheduler.ts` (`createTickScheduler`): synchronous `process.nextTick` callbacks queued during a guest task (`runEntry`, `pump`, `emitBeforeExit`) drain synchronously when that task returns before any promise reaction or native `await` runs, while ticks queued during the host microtask checkpoint (including after native `await` chains) schedule a host macrotask checkpoint and drain at the start of the next turn once V8's microtask queue has emptied and ahead of the next timer or immediate.

## Classification

| Local source | Class | Provenance and reason |
| --- | --- | --- |
| `crates/bunwasm-engine-quickjs/src/vm.rs` (`run_jobs`) | Host feature | Drain all QuickJS microtasks per `Engine::run_jobs()` call to match JSC and the trait contract. |
| `crates/bunwasm-runtime/src/js/bootstrap.js` (`nextTick`, `runTicks`, `runTimers`, `reportCallbackError`) | Host feature | Per-tick `handleUncaught` dispatch preserving host exits and unwinds, re-entrant tick draining guard, and immediate exception deferral/yielding across the active batch. |
| `crates/bunwasm-runtime/src/js/bun_test.js` (`invokeCore`, `runHooksMaybeSync`, `executeTest`) | Host feature | Run serial test `beforeEach` hooks and body in the same scheduled macrotask turn via `realTimers.setImmediate`. |
| `web/src/tick-scheduler.ts`, `web/src/engine-host.js` | Host feature | Typed tick checkpoint scheduler draining synchronous ticks at guest task boundaries and microtask-queued ticks at the next host turn boundary on V8/Browser hosts. |

[Ledger scope and pinned revisions](scope.md).
