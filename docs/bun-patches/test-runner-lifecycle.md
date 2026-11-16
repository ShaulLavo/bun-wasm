# Test registration and repeated execution

Class: Original adapter.

`crates/bunwasm-runtime/src/js/test_lifecycle.ts` implements retry/repeat options
and repeated serial test execution. The wiring in
`bun_test.js` adds `jest.setTimeout`, `onTestFinished` and test-local `afterAll`
hooks. No upstream implementation is copied.

The behavior references Bun's `src/runtime/test_runner/ScopeFunctions.rs` and
`src/runtime/test_runner/Execution.rs`, and the unchanged tests under
`test/js/bun/test/`, at revision
`9510e74152073d850a18758ca41114d8f214ffa6`. Native Bun 1.4.4 at revision
`38afee6c8` supplies the order, return-value and error controls.

Every attempt gets fresh assertion and cleanup records. Test-local `afterAll`
hooks run in reverse registration order, followed by inherited `afterEach`
hooks and then `onTestFinished` callbacks in registration order. A cleanup
failure stops the remaining cleanup hooks. Both body and cleanup failures retain
their diagnostics. Failed retries retain their diagnostics without increasing
the final test count. Repeats continue only after a passing attempt.

Cleanup consumes live local and finished queues: newly registered cleanup runs
in its phase instead of being lost from an earlier snapshot. Reentrant rejection
still fails the test and stops later cleanup. Skipped and todo describe scopes
retain their pre-existing callback-free behavior.

Expected-failure tests classify the body separately from cleanup. A successful
body with rejected cleanup fails; an already failing body remains an expected
failure, while the cleanup diagnostic stays visible. Retry and repeats option
types are both validated before checking their mutual exclusion.
The timeout accessor is read once before the retry/repeats accessors, preserving
native error precedence and mutations that alter the requested repeat count.

Callable describe and new label validation are deferred. The existing describe
registration function is unchanged from the original base. This adapter does not
claim async describe completion or recover the two upstream callable cases.

Concurrency remains serial. Concurrent scheduling needs separate asynchronous
test and invocation ownership before overlapping tests can safely share this
runner. This adapter does not change assertion settlement or snapshot values.
