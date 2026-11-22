## `process.nextTick` microtask checkpoint and exception handling

Class **Host feature**, **original adapter** across QuickJS (`crates/bunwasm-engine-quickjs/src/vm.rs`), the shared JS runtime (`crates/bunwasm-runtime/src/js/bootstrap.js`, `crates/bunwasm-runtime/src/js/bun_test.js`), and the Browser host (`web/src/engine-host.js`). No upstream implementation is copied. The reference behavior is Bun's `process.nextTick` and `bun:test` turn model (`test/js/node/process/process-nexttick.test.js` at Bun `9510e74152073d850a18758ca41114d8f214ffa6`, checked against native Bun 1.4.4).

- `QuickJs::run_jobs()` drains all pending QuickJS jobs in a loop before returning to `Core::drain_jobs()`, matching the `Engine::run_jobs` trait contract and JSC's `bunjsc_drain_microtasks()`. Previously, executing one job per loop interleaved `process.nextTick` callbacks between microtasks queued in the same checkpoint.
- `processTicksAndRejections` (`bootstrap.js`) catches exceptions per tick callback and routes each through `internal.handleUncaught(err)` (exiting with status 1 if unclaimed), so subsequent queued ticks continue to drain when an `uncaughtException` listener handles the error on every engine.
- `bun_test.js` starts each serial test body (`concurrentGroups === 0`) in its own macrotask via `internal.realTimers.setImmediate`, so synchronous `process.nextTick` calls before the first `await` run at the end of the turn before promise continuations, while ticks scheduled after `await` defer until the microtask checkpoint completes.
- `EngineHost` (`web/src/engine-host.js`) tracks the turn's microtask checkpoint (`inMicrotaskPhase`, `markMicrotask`, `pollMicrotaskEnd`): synchronous `process.nextTick` callbacks drain before wrapped promise reactions, while ticks queued during the microtask phase wait until the active microtask wave settles and then drain within the same checkpoint before the next timer or immediate.

## Classification

| Local source | Class | Provenance and reason |
| --- | --- | --- |
| `crates/bunwasm-engine-quickjs/src/vm.rs` (`run_jobs`) | Host feature | Drain all QuickJS microtasks per `Engine::run_jobs()` call to match JSC and the trait contract. |
| `crates/bunwasm-runtime/src/js/bootstrap.js` (`nextTick`, `runTicks`, `runTimers`) | Host feature | Per-tick `handleUncaught` dispatch, re-entrant tick draining guard, and immediate exception deferral across the active batch. |
| `crates/bunwasm-runtime/src/js/bun_test.js` (`executeTest`) | Host feature | Start serial test bodies in a fresh macrotask turn via `realTimers.setImmediate`. |
| `web/src/engine-host.js` (`enterRoot`, `markMicrotask`, `pollMicrotaskEnd`, `scheduleTick`) | Host feature | Drain synchronous ticks before promise reactions and microtask-queued ticks once the microtask wave settles on V8/Browser hosts. |

[Ledger scope and pinned revisions](scope.md).
