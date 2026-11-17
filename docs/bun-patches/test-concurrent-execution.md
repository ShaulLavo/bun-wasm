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
and `afterAll`, as before. Within a group, each test runs its own `beforeEach`
hooks, body and cleanup. Bun steps a test until one of its callbacks really
waits, then starts the next test. Here tests run in lanes that take tests in
order, and a new lane starts whenever a running callback is still unsettled
three microtask turns after it returns. A callback that already finished,
async or not, settles before then, and no timer can have run yet. So tests that
never wait run one after another, and tests that wait overlap. At most
`--max-concurrency` lanes run at once (default 20; 0 removes the limit).
Results are reported as tests finish. The turn count stands in for Bun's direct
promise-state check because the Browser host cannot see an async function's
promise state. A test that awaits several already-resolved promises before its
first real wait can therefore print a line earlier than in Bun.

`test.concurrent`, `test.failing` and the other modifier variants are each made
on first use and then kept, so `it.failing === test.failing` as in Bun.

Outside a group one test runs at a time, and the running test and its
invocation are module state, as before. Inside a group each test runs in its
own async context frame (`internal.runInContext`), so an assertion, inline
snapshot, `onTestFinished` or uncaught error after an `await` reaches the test
it came from. Bun instead treats the current test as unknown inside a group, so
there it counts expectations only in the summary and rejects snapshot matchers.
Where an engine does not carry the frame across a continuation (a Browser host
without an async-context provider), the adapter falls back to that same
unknown-test behavior. Code outside every test of a group, such as a timer the
group did not start, reports errors between tests.

The `test-concurrent-groups` and `test-concurrent-flags` fixtures cover these
rules on every engine.
