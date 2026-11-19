# Root memory-group stop adapter

Class **Host feature**, **original adapter** in
`web/src/{runner,subprocess-broker}.ts` and
`web/tests/fixtures/worker-entry-observation-probe.ts`. No upstream implementation
is copied. The provider boundary is Waffle's `RootMemoryGroupMember` in
`packages/waffle/browser/process-broker.ts`, exported through `waffle/runtime`.
The consumer selects public Waffle 0.0.142 at
`38c0b979ae958fd5acb1b1819135096df0832d9b`. Earlier source checks used reviewed
`e01ed9806373376a5249266da8572454a2bab50e`, 0.0.138 at
`876be3fa82098f465a6feada013255181342302a`, 0.0.139 at
`8e86a2a0f2398c1485ef16f7bc423961f4e05f94` and 0.0.140 at
`1a2e4b3d5b4c8ae77863f60b88b33c9e9af2082b`; `RootMemoryGroupMember` and
`admitRootMemoryGroup` are unchanged
between those commits. This adapter does not promise native backing release.

The runner captures its exact admitted membership and root retention lease before
invoking the native worker stop. It forwards `terminating()` immediately after
that invocation in `finally`, including synchronous failure, before awaiting any
returned promise. This records an attempted termination. It does not establish
physical completion or release ownership debt.

Native-return observation and `stopped()` remain after a successful native join.
A throw or rejected join retains the existing failure and ownership debt. A
receipt retained from an older admission cannot mark a later group for the same
PID. Delayed worker acquisition and the adopted controller use the same single
stop operation. Independent helper workers never receive the root receipt.

Group admission is synchronous after root adoption. Cancellation is checked
after the asynchronous adoption, so stopping during preparation cannot publish a
new group after the worker's stop receipt was captured.

`scripts/root-worker-stop.test.ts` checks native invocation ordering.
`web/tests/subprocess-broker.test.ts` checks exact memberships through the consuming
web installation's real group admission and termination API. The runner controls
also prevent group admission after a stop during asynchronous root adoption.
These checks do not qualify a provider release or native memory reclamation.
Native acceptance belongs to the matching provider integration.
