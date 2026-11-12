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

The campaign executor also preserves failure-time terminal output alongside its
later cleanup observation in the same log. Generic cleanup observes after the
server stop; owned cleanup observes before transport cleanup. A missing
failure-time observation is labelled as unavailable. Successful logs retain
their existing format. The Angular diagnostic and iPhone executor fixtures
cover both cleanup paths and unavailable observations.
