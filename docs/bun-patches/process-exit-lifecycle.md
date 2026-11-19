# Process exit and uncaught-exception lifecycle

Class **Port**. The runtime's `process.exit`, `process.exitCode`, uncaught
exception handling and `beforeExit` dispatch follow Bun at revision
`9510e74152073d850a18758ca41114d8f214ffa6`. No Bun source is copied. The JavaScript and Rust
below reimplement these upstream functions:

| Upstream | Behaviour reproduced | Where |
| --- | --- | --- |
| `src/jsc/bindings/BunProcess.cpp` `setProcessExitCodeInner`, `processExitCode` | `process.exitCode` validates with Node's `validateInteger` after numeric strings convert, keeps the low byte, ignores `undefined` and `null`, and reads `undefined` until set | `crates/bunwasm-runtime/src/js/process.ts` |
| `BunProcess.cpp` `Process_functionExit`, `Process_functionReallyExit` | `process.exit()` sets the code, emits `exit` (which sets `_exiting`), then calls `process.reallyExit` as a method with the code the listeners left; a non-callable `reallyExit` throws `TypeError: process.reallyExit is not a function`. `reallyExit` keeps an integer's low byte and exits 0 for anything else | `process.ts` |
| `BunProcess.cpp` `Process_setUncaughtExceptionCaptureCallback`, `Process_hasUncaughtExceptionCaptureCallback`, `Process_functionFatalException` | The capture callback, its `ERR_INVALID_ARG_TYPE` and `ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET` errors, and `_fatalException(error, fromPromise)` returning whether a handler claimed the error | `process.ts` |
| `BunProcess.cpp` `Bun__handleUncaughtException`, `src/jsc/VirtualMachine.rs` `uncaught_exception` | A non-callable `process._fatalException` exits 6. `uncaughtExceptionMonitor` runs first, then the capture callback or else the `uncaughtException` listeners. A throw from a listener exits 7 (1 in a worker), one from the capture callback exits 1. An unclaimed error exits with the code the `exit` listeners leave | `crates/bunwasm-runtime/src/js/bootstrap.js` `dispatchUncaught`, `fatalExit` |
| `VirtualMachine.rs` `on_before_exit`, `BunProcess.cpp` `Process__dispatchOnBeforeExit` | A throw from a `beforeExit` listener goes to the uncaught handlers. The microtasks and ticks the listeners queue run before `exit`, and `beforeExit` comes again only after loop work they left alive | `bootstrap.js` `emitBeforeExit`, `loopAlive`; `crates/bunwasm-engine-quickjs/src/program.rs` `resume_idle` (QuickJS and JSC); `web/src/engine-host.js` `finish` (Browser) |
| `VirtualMachine.rs` `on_exit` | A throw from an `exit` listener goes to the uncaught handlers before it counts as fatal | `bootstrap.js` `emitExit` |
| `src/js/builtins/ProcessObjectInternals.ts` `createProcessFinalization` | `process.finalization.register`, `registerBeforeExit` and `unregister`, with listeners appended at the first registration and only the target validated | `process.ts` |

## Differences from native Bun 1.4.4

Native Bun reports a top-level throw of the entry module with origin `unhandledRejection`,
because it evaluates the entry through a promise. bun-wasm reports `uncaughtException`, as Node
does. Native Bun also exits 1 after an unhandled throw from a timer even when an `exit` listener
assigns another code; bun-wasm exits with the assigned code in every case, as the upstream
`changeCodeInExitWithUncaught` test and Node expect. The fixtures avoid both cases.

## Exits that unwind

On the browser engine `native.exit` ends the run and then throws to unwind the guest's stack.
`process.reallyExit`, `process.abort` and the fatal paths set `internal.exitStarted` first, and the
handlers that catch errors (the uncaught exception handlers, `beforeExit` dispatch and the `exit`
emit) rethrow what they catch once it is set. So `process.exit(3)` inside an `uncaughtException`
or `beforeExit` listener exits 3 instead of being reported as that listener's error.
`web/tests/process-signals.test.ts` covers both with a `native.exit` that throws.

## Known differences in workers (not changed here)

These predate this change and behave the same on all three engines:

- `process.exit(13)` inside a worker's `exit` listener gives the parent an error event before exit
  13, because `native.exit` does not publish `internal.workerExit` first.
- A throwing `exit` listener in a worker gives the parent an error and then exit 1. Bun gives exit
  0 and no error.

## What the host sees

The exit code of these paths now matches Bun: 6, 7 and listener-assigned codes reach the host
instead of 1. When the process ends is unchanged except for `beforeExit`, which no longer fires a
second time after microtask-only work.

## Tests

The native fixtures `process-exit-really-exit`, `process-exit-really-exit-missing`,
`process-uncaught-capture`, `process-uncaught-exit-code`, `process-uncaught-handler-throws`,
`process-uncaught-fatal-exception-deleted`, `process-before-exit-lifecycle`,
`process-before-exit-fatal` and `process-finalization` hold native Bun's output and run on all
three engines. `scripts/fixtures/process-controls.ts` checks the exit code validation and the
`reallyExit` call in the unit controls.

[Ledger scope and pinned revisions](scope.md).
