# Goals phase admission

Classification: original local test adapter. No upstream implementation is copied.
The implementation lives in `scripts/goals-matrix/scope.ts`, `transport.ts` and
`execute.ts`; `bounded.ts` retains its independent callers and behavior.

A finite scope owns an absolute deadline and cancellation reason. It closes before
failure capture starts. A bound transport view admits every helper call and ends
its await at that deadline without cancelling the underlying dispatched operation.
Narrowed admissions enforce their own earlier cutoff even while the parent signal
is live. Timers and parent listeners are removed on settlement and explicit close.

Failure and final logging retain discriminated observed or unavailable terminal
outcomes. Empty output is a successful observation. Optional diagnostic expiry
preserves an already observed terminal, and unavailable final logs name the final
and capture reasons. Cleanup handoff scopes close before unguarded resource
teardown. Existing phase errors and observation, cleanup and close budgets remain
unchanged. The Angular reader receives the same bound view and observation cutoff.
