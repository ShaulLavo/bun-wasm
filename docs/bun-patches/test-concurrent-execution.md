# Concurrent test execution

Class: Original adapter.

`crates/bunwasm-runtime/src/js/bun_test.js` runs `test.concurrent`,
`describe.concurrent`, `--concurrent` and `--max-concurrency` the way Bun's
`src/runtime/test_runner/Order.rs`, `Execution.rs` and the `concurrent` field
of `BaseScope` in `bun_test.rs` do at revision
`9510e74152073d850a18758ca41114d8f214ffa6`, checked against native Bun 1.4.4.
No upstream code is copied.

A test is concurrent when it or its nearest marked describe block uses
`.concurrent`, or when the file runs with `--concurrent`. `.serial` opts out.
Modifiers chain in any order (`test.concurrent.each`, `test.concurrent.failing`,
`test.only.serial` and so on).

A file runs as a flat list of steps. Consecutive concurrent tests form one
group, even across describe blocks. `beforeAll` and `afterAll` hooks are steps
of their own, so they end a group. A failed `beforeAll` skips its scope's tests
and also its `afterAll`, as this runner did before groups existed. That differs
from Bun, whose `set_failure_skip_to` in `Order.rs` still runs the scope's
`afterAll`. Within a group, each test runs its own `beforeEach` hooks, body and
cleanup.

Bun steps a test until one of its callbacks really waits, then starts the next
test. It decides by draining the microtask queue after the call and then
reading the callback's promise, so a callback that awaited only settled values
has finished and never counts as waiting. Here tests run in lanes that take
tests in order, and a new lane starts whenever a running callback really waits,
up to `--max-concurrency` lanes at once (default 20; 0 removes the limit). So
tests that never wait run one after another, and tests that wait overlap.
Results are reported as tests finish.
- QuickJS, JSC and the other in-guest engines own their job queue. They drain it
  fully after the call and then check whether the callback settled, as Bun
  does.
- The Browser host can neither run its native promise jobs synchronously nor
  see an async function's promise state. There, a callback still unsettled
  three microtask turns after it returns counts as waiting. A finished callback
  settles within two turns, and no timer can have run yet. A test that awaits
  several already-resolved promises before its first real wait can therefore
  print a line earlier than in Bun on that engine.

`test.concurrent`, `test.failing` and the other modifier variants are each made
on first use and then kept, so `it.failing === test.failing` as in Bun. Every
variant has its own `if`, `skipIf`, `todoIf` and `failingIf`, as in Bun.
`test.concurrent.skipIf(true)` gives `test.concurrent.skip`, and
`describe.failingIf(true)` throws as Bun's does.

Outside a group one test runs at a time, and the running test and its
invocation are module state, as before.

Every test and hook is called in the async context it was registered in, as
Bun does, so a store entered at the top of the file or around the registration
is visible inside it. A `describe` callback runs in its caller's context, so an
`enterWith()` inside it reaches only what it registers. Bun gets the same
effect by running describe callbacks after the file loads. Native Bun 1.4.4
then times such a test or hook out even though it finished; that's an upstream
bug, and here the test passes.

Inside a group, each test's slot is the store of a private `AsyncLocalStorage`.
It's pushed on top of that registration context, and entered again around each
hook and body call, because runtime JS awaits between them. User stores and
the slot therefore live side by side: `als.run()` or `enterWith()` inside a
concurrent test keeps the test, and stores set before it stay visible. So an
assertion, inline snapshot or `onTestFinished` after an `await` reaches the test
it came from. Bun instead treats the current test as unknown inside a group, so
there it counts expectations only in the summary and rejects snapshot matchers.
Where an engine does not carry the frame across a continuation (a Browser host
without an async-context provider), the adapter falls back to that same
unknown-test behavior. Code outside every test of a group, such as a timer the
group did not start, reports errors between tests.

Two known differences remain:
- An uncaught error inside a concurrent group differs by engine. QuickJS, JSC
  and Browser with `--context hooks` print "Unhandled error between tests", and
  the test passes, as in Bun. On Browser without an async-context provider, the
  error fails the test.
- `expect.assertions`, `expect.hasAssertions` and `onTestFinished` work inside
  concurrent tests here. Bun throws for them there.

The `test-concurrent-groups`, `test-concurrent-flags` and
`test-concurrent-stores` fixtures cover these rules on every engine, and on the
Browser engine also with `--context hooks`. `test-concurrent-stores` has
hand-written expectations because of the Bun timeout bug above.
`test-concurrent-settled` covers callbacks that await only settled values. It
runs on QuickJS, JSC and SpiderMonkey and skips the Browser engine.
`test-concurrent-uncaught` skips Browser only without `--context hooks`. Both
skips are for the differences described above.
