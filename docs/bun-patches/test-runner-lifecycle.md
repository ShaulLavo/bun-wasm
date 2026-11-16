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
runner. This adapter does not change matcher values or ordinary assertion settlement.

A private, opaque file token now spans serial file collection, execution and
snapshot flushing, and is restored in `finally`. The closure-local
`getExpectationOrigin()` exposes only readonly opaque identities for the active
file, test and invocation. It does not change their records, carry asynchronous
context, or define matcher validity across hooks or tests.


Expected-failure bodies retain timeout failures. Done callbacks use the first
callback result and keep their invocation open through the callback's return and
settlement of a returned promise. Same-callback throws and returned
rejections therefore fail the owning test. Successful done completion yields one
microtask before closing; ordinary invocation completion retains its previous
settlement path. Direct settlement callbacks avoid depending on Browser observation of an
unobserved async-function Promise. Completed bodies add no timer checkpoint;
matcher pending observation, the host and public Promise behavior stay unchanged.

This is bounded completion behavior. Native Bun can complete an already fulfilled
async return before done is called; this adapter keeps its existing missing-done
timeout requirement. Native can also print both a done error and a subsequent
returned rejection; this unit preserves the first failure rather than claiming
multiple-error diagnostic parity. Neither difference needs a synchronous drain.

CLI preload imports are attempted once into one existing scope-shaped object.
Ordinary roots retain only its parent pointer, so each hooks inherit in order
without replaying imports or copying hook arrays. Global setup runs after the
first ordinary import attempt, including empty or filtered files. Global teardown
is consumed before awaiting it during the last file's finalization, before
snapshot flush. Import and local-hook errors do not bypass that finalization;
teardown and snapshot errors are reported separately. Existing bail exits remain
process exits.

Registration rejects during preload before validation, option access or each-table
expansion, including modified, callable and empty-each forms. Hook registration
continues to use the temporary preload scope. The preload guard and collection
cursor restore after awaited import failures. Outside-runner errors name the
specific registration API.

Preload import and setup failures deliberately fail closed. Rejected preload
imports execute no partial hooks or ordinary modules and do not replay. Failed
global setup suppresses later test bodies and setup replay, but attempts the
registered global teardown once. Native Bun 1.4.4 instead runs partially declared
preload hooks after an import failure and resumes later-file bodies after global
setup failure. These are explicit product differences, covered by negative
controls rather than native-parity claims.
