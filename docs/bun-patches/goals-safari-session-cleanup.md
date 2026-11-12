# Goals Safari session cleanup

Class **Host feature**, **original test adapter** in
`scripts/goals-matrix/safari-transport.ts` and `execute.ts`. No upstream code is
copied.

A page expression can remain pending when its outer matrix phase expires. The
old cleanup queued session deletion behind that expression. Its 90-second request
timeout then exceeded the separate 10-second session cleanup allowance, leaving
Safari paired with the previous session and blocking later cells.

Interrupted matrix cleanup aborts pending HTTP requests, rejects queued page
operations, and deletes the owned session through a separate request. Ordinary
non-interrupted transport close still drains its queue. Session deletion remains
cached, runs once, and keeps its original 10-second maximum. The matrix phase and
20-second outer cleanup deadlines do not change.

The focused regression holds a real HTTP command open with a 90-second deadline,
requests interrupted cleanup, and verifies that deletion and a second session
finish without waiting for that command. It also checks the queued operations
reject rather than execute against a deleted session.

Ordinary commands now carry a finite phase admission. The serial queue retains
its dispatched command while a caller stops awaiting at its deadline. A queued
command that loses admission is withdrawn. Every subsequent WebDriver send after
an internal await checks admission again. A newly created preview handle remains
owned for session teardown even if cancellation prevents selecting or navigating
it. Failure cleanup and session deletion remain unguarded resource release.

Desktop counter checks use WebDriver's element-click command through the same
serial queue and finite admission. The original counter must change from zero
to one. A listener in the preview must also observe `event.isTrusted` on the
armed button, with its document and target identity preserved. DOM `.click()`
cannot satisfy this evidence. Failed native input is not retried. iPhone input
keeps its existing device transport.

HTTP fixtures check request order, failures, cancellation, and cleanup ownership.
Chromium and Playwright WebKit controls check real event trust and reject DOM
clicks. These controls do not prove native Safari input. The first coherent
delivery's desktop Safari session must run a bounded trusted-counter control
before framework acceptance.

The campaign executor also preserves failure-time terminal output alongside its
later cleanup observation in the same log. Generic cleanup observes after the
server stop; owned cleanup observes before transport cleanup. A missing
failure-time observation is labelled as unavailable. Successful logs retain
their existing format. The Angular diagnostic and iPhone executor fixtures
cover both cleanup paths and unavailable observations.

Opt-in ownership capture uses the original local adapter in
`safari-ownership.ts`. It observes only the existing session creation, host handle,
preview creation, frame reference/selection and teardown requests. Records separate
intent, dispatch, acknowledgement and request failure. An acknowledgement carries
only the identifiers returned for that operation. Failed requests have unknown
effects, and an expired admission is labelled even when its request later returns.
Sink failures are deferred until session deletion has been attempted and aggregate
with an original cleanup error. Capture adds no browser requests or context inventory.
