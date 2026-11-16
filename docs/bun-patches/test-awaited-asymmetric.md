# Awaited asynchronous asymmetric assertions

Class: Original adapter.

The private expect comparison in `src/js/util.ts`, the settlement callers in
`src/js/bun_test.js`, and the sequential helpers in `src/js/test_matchers.ts`
implement awaited asymmetric assertions. Behavior is compared with Bun's
`src/jsc/bindings/bindings.cpp`, `src/runtime/test_runner/expect.rs` and
`test/js/bun/test/expect-extend.test.js` at revision
`9510e74152073d850a18758ca41114d8f214ffa6`, and native Bun 1.4.4.
No upstream implementation is copied into these additions.

Synchronous comparisons stay inline, and successful synchronous assertions return
undefined. Only an actual matcher Promise makes the final assertion return a
Promise. Awaited success resolves to undefined. This is a bounded contract:
native Bun drains matcher jobs and timers before returning undefined, whereas
this adapter returns before those effects complete. A custom matcher using
`this.equals` with an asynchronous nested matcher must await that comparison or
return its chain before constructing its result. A Promise-valued `pass` is
invalid. These return-order and callback differences are intentional and are not
native synchronous parity. Public Bun.deepEquals, Node equality, Node assertions
and their boolean declarations remain synchronous and do not call matchers.

The private comparison checks the expected matcher before the received matcher,
including identical matcher objects. It checks property presence and strict hole
presence before callbacks, reads encountered properties once, and visits later
comparisons only after earlier results pass. Active ancestor pairs live through
settlement; completed siblings, failed candidates and independent assertions do
not share memo entries. Maps choose the first matching key and compare that
entry's value once. Sets retain insertion-order search and candidate reuse.

The private util entry also receives the expectation factory's matcher predicate.
Array data descriptors distinguish holes and indexed accessors without invoking
getters. A loose comparison reads an indexed accessor when the other side is a
matcher, then settles that comparison before visiting the next index. Strict
presence checks still precede matcher calls. Ordinary proxy-array reads retain
their order. Public Bun.deepEquals never receives the predicate.

Direct throws preserve their identity. Actual matcher Promises get intrinsic
fulfillment and rejection reactions immediately, without reading public `then`,
constructor or species. Rejection prints the original reason once through the
runner's handled diagnostic formatter and rejects the assertion with a distinct
Error, `Matcher \`name\` returned a promise that rejected`, without cause. Later
getter, validation and continuation errors are outside that boundary. Plain
thenables are result objects; their `then` is never read. Asymmetric mismatches
do not evaluate failure messages before outer negation.

Equality, containing, property, throw, mock call and return, nth-return, and
snapshot property callers settle before branching. Mock recording and spying
are unchanged. Each final assertion belongs to its invocation, including
resolves and rejects. Snapshot file, error and call-order identity are captured
at entry. A continuation after timeout does not update another case's counters,
snapshots or input object.

The pending assertion observer captures `internal.realTimers.setTimeout`, the
existing startup timer authority, rather than reading the replaceable global
during lazy matcher initialization. Source controls replace the global with a
string, Symbol and bigint before loading the factory and complete pending
observations through the stable timer. This also preserves lazy Bun.jest
initialization before fake-timer activation. No clock, native timer, provider or
global timer behavior changes.

The maintained comparison fixture documents bounded timing expectations. The
ownership fixture runs successful, false and rejected unawaited assertions in
subprocesses, checks distinct failed names independently of recap lines, and
checks late settlement and snapshot call order. Existing upstream assertions
remain unchanged. Feature-owned native manifests cover all four local engines;
the source factory test uses the actual private util entry.

Promise modifiers return an intrinsic final continuation that resolves to
undefined. That final Promise is the one returned and tracked. This makes its
settlement visible through the existing Browser reaction implementation, where
an otherwise unobserved async-function Promise has no known state. Ordinary
assertions retain their existing reaction count. No host observation or pump
changes are involved. Stack-bearing Error rejection checks run inside the owned
subprocess fixture; the comparison fixture pins the existing two-line primitive
diagnostic without depending on engine-specific stack columns.
