# Memory attribution requires a caller root

The corrected memory hook preserves every raw process observation. It never
selects scope from command sequence, timestamps, job identity, or activity.
A later finished helper can coexist with an earlier active build.

`sample({ page, phase, engine, rootId })` returns raw observations in
`rawProcesses` and validated observations in `processes`. `observedFailures`
retains failure facts without assigning them to an unknown command tree.
When root attribution is unavailable, scalar counters and headroom remain
null, and `attribution.kind` is `unknown`.

The frozen host has no numeric guest PID or parent edges. Passing one of its
telemetry UUIDs or command labels as a root does not establish ancestry. Its
engine and allocator facts remain available per process. Cached engine heap
values describe the last successful refresh; they are not failure-time heap
measurements.

## Approved next host contract

This contract is not implemented by the frozen host. It requires a separate
host revision and real runtime qualification, with no guest or engine rebuild.

The caller binds a measurement root when it launches the command. `startRun`
accepts that `memoryRootId` and returns it on its handle. The caller retains the
identity across compile, child exit and terminal sampling. It passes the same
identity to the hook. A foreground or latest-root lookup is not a substitute.

The page host maps the root to its actual Waffle runtime and guest PID after
admission. Child parent PIDs come from Waffle's process context and supervisor,
including intermediaries. Job IDs, UUID prefixes, observation order and OS PIDs
never create parent edges. Root and terminal-child witnesses survive reap.

The separate `__bunMemorySnapshotEnvelope` getter returns complete raw
`processes` plus `roots`. A root entry has:

```ts
{
  authority: "runtime-supervisor",
  complete: true,
  runtimeId,
  rootId,
  rootPid,
  members: [{ pid, parentPid, telemetryId, terminal }]
}
```

The supervisor supplies the complete member inventory, including opaque
processes. Missing telemetry or parent edges block aggregation. The hook checks
that every member reaches the explicit root, identities are unique, and the
root snapshot matches the caller. It sums only active members and retains
terminal failure provenance separately. Independent memory limits do not become
one shared headroom budget. The full raw list remains available, including
unrelated commands.

The hook already validates this envelope. It makes no claim that an unqualified
host implements it. The frozen host continues to return an array, which has no
authoritative inventory and therefore produces unknown aggregate counters.

## Replay real observations

```sh
source env.sh
bun scripts/replay-engine-lineage.ts RAW_JSONL REPORT_JSON
bun scripts/replay-engine-lineage.ts JSC_RAW_JSONL REPORT_JSON cached
```

The replay requires an explicitly named complete raw getter field. It preserves
all observations, checks that active processes remain present, and rejects any
inferred legacy aggregate. Reports record the input digest and line numbers.
