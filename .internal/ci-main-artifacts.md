# Latest main CI and artifacts

Status: Approved.

Main pushes share `CI-push-main` and cancel the running and pending superseded
main runs. PRs still cancel earlier runs of the same PR. Manual dispatches keep
their unique run groups. The separate native identity locks are unchanged.
The Web host and Code quality aggregates qualify their job-level `always()` with
a main-only cancellation guard. Processes already rejects cancellation. Failed
prerequisites still reach the blocking aggregates; PR and manual cancellation
behavior is unchanged. No job remains eligible to hold a cancelled main workflow.

Every main push selects all four native families. A docs-only push can replace a
native-source push, and its successful run still publishes the current program
set. PR and manual runs retain the immutable comparison and path classifier.
No previous main success, history walk, Actions API lookup or cumulative marker
is needed. Source quality, native checks, browser matrices and the final required
Code quality aggregate keep their existing blocking behavior.

The existing Rust producer publishes `browser-program`, containing the standard
Browser and tools guests and their source-bound receipts, `browser-guest-site`,
`ordinary-jsc-program`, `ordinary-spidermonkey-program` and
`native-profile-launcher`. JSC selection enables its ordinary program export;
shared-native selection enables the launcher export. Shared sysroot proof
publishes `shared-quickjs-program`, `shared-jsc-program` and
`shared-spidermonkey-program`. All four flags must therefore be true on main.
These are this run's existing producers and uploads, with no copied artifacts
from an earlier green commit. Upload failures remain blocking.

`checks/quality-ci-main-artifacts.json` owns the proof. It executes the workflow's
actual selection shell for main, PR and manual events, checks producer dependency
and step conditions through every listed upload, and tests failure propagation
through the actual final aggregate. The PR policy proof evaluates cancellation
for main, PR, manual and other refs. Hosted admission and artifact publication
still need observation after merge; source tests establish no timing improvement.
