# Memory attribution requires a caller root

The bounded launcher observation getter adds runtime and guest process identity,
retained allocator samples, and adapter-cleanup worker censuses. It does not
implement the supervisor-complete envelope described below. Missing observations
remain unknown, and a libc failure alone does not establish its cause.

The corrected memory hook preserves every raw process observation. It never
selects scope from command sequence, timestamps, job identity, or activity.
A later finished helper can coexist with an earlier active build.

`sample({ page, phase, engine, rootId })` returns raw observations in
`rawProcesses` and validated observations in `processes`. `observedFailures`
retains failure facts without assigning them to an unknown command tree.
When root attribution is unavailable, scalar counters and headroom remain
null, and `attribution.kind` is `unknown`.

The legacy snapshot array has no numeric guest PID or parent edges. Passing a
telemetry UUID or command label as a root does not establish ancestry. Cached
engine heap values describe the last successful refresh; they are not
failure-time heap measurements.

## Bounded launcher observations

`globalThis.__bunMemoryProcesses()` is a synchronous, nonthrowing, read-only
getter. It returns schema 1 with `processes`, current `runtimes` censuses, recent
`censuses` at `adapter-cleanup`, and `loss` counts. It reads cached samples and
already registered services. It never activates a runtime, requests a channel
sample, refreshes engine counters, schedules work, or forces GC. Its service
and runtime references are weak. Disposed runtimes retain cached process rows
but their service is not read.

The launcher binds `{ runtimeId, pid, parentPid, job }` at entry, before async
setup or worker launch. Runtime identity comes from the same WeakMap as command
identity. Join processes by runtime and PID. An entry that fails during setup
can have an identity and outcome without a memory sample. Direct roots managed
by `runner.ts` remain `unbound`. This is launcher coverage, not a complete
supervisor inventory. No command or root is inferred from observation order.

Outcomes preserve `exited`, `signaled`, and `start-failed`. An observed null
outcome means the read succeeded without a selected outcome. An unavailable
outcome means the read failed or no bound outcome reader was supplied. These
states do not become exit codes. Channel errors become bounded `invalid` or
`read-failed` states; cleanup still detaches the channel. Late frames cannot
reopen completed rows or replace another command's identity.

The campaign's `engineMemoryLog` reads this getter for SpiderMonkey at the
existing failure and final-log boundaries. Row classification uses this order:
unbound identity, invalid/read-failed channel, pending lifecycle, missing sample
or capacity, unsupported libc records, cached-live sample, then measured
failed-request or no-failed-request. A no-failed-request row needs a valid final
sample with successful reads of **both** `bun_memory_telemetry` and
`bun_memory_failure_telemetry`. A placeholder, a declared maximum, or one export
alone is insufficient. Getter absence, unsupported schema, unavailable shared
buffers, invalid data and output loss have explicit states. Null remains null.
SpiderMonkey engine heap counters are unsupported.

`sample.time` and `sample.terminal` retain the worker sample boundary. Launch
and cleanup times and sequences describe host observations, not exact guest
exit or allocation order. An adapter-cleanup census can include a physically
stopped worker whose row has not retired. Other workers may have retired
earlier. Concurrent cleanup order cannot establish original failure order.

Retention has hard limits of 128 active processes, 128 terminal processes,
16 weak runtime registrations, 16 recent cleanup censuses, 128 workers per
census, and 512 KiB of serialized observation data. Process identities and
snapshots are evicted together. `loss` counts eviction and output omission;
each census reports truncation and unknown-byte rows. `incomplete` summarizes
known coverage gaps. Eviction is not measured absence. Current runtime census
states distinguish observed, not-registered, disposed, and read-failed.

`knownSampledBytesSubtotal` sums known sampled worker linear-memory byte
lengths. Unknown or omitted rows prevent a complete total. Values can be stale
during pure Wasm execution. These bytes are not RSS, physical commitment,
allocator live bytes, a peak, or complete page usage. They omit directly
managed roots, filesystem buffers, JavaScript heaps, compiled code, helper and
notification workers, auxiliary memories, other services and other pages.
Worker engine labels come only from retained bindings; unknown adapters remain
null. `directory` and `rootPid` preserve worker attribution. They cannot
identify shared backing allocations, so sums are always alias-uncertain.

The frozen libc record is the first outer allocation failure for that process.
It has no allocation timestamp or sequence and may describe a caught earlier
failure. Its capacity fields remain separate from the current sample's
capacity. A failure near the maximum is consistent with a capacity constraint.
A failure below the maximum establishes unused declared address space, but
does not prove `memory.grow` was attempted or refused by the browser. Oversized
requests, pre-growth failures and fragmentation remain possible. No recorded
libc failure does not prove an engine limit. Allocator live bytes do not
separate retained arenas, fragmentation, static/stack data or other gaps.

The real split/interpreter positive control runs a parent Bun command with
synchronous `node` children after a pre-control host sequence boundary. A
trivial setup command loads the lazy launcher before that read. Each child
prints a post-entry sentinel under the control's unique nonce. The fail child
requests exactly `new ArrayBuffer(1_073_807_360)`, prints a caught-error sentinel
and exits 70. Each `spawnSync` result supplies its actual child PID, outcome,
and separately captured mode/nonce stdout and stderr. Assertions require
exactly one runtime containing both newly bound children and one common
measured parent with its own launcher row. The failure census corroborates
their parent edges, directory, root, individual observed jobs and known bytes.
Both libc exports must be readable, and parent cleanup must not have been
observed at that child census. The guest currently reports fixed compatibility
values for `process.pid` and `process.ppid`; neither is an identity oracle.
This qualifies returned-child PID binding and host parent attribution, without
an independently guest-printed parent oracle. It does not reproduce an in-guest
bootstrap failure, pre-entry Waffle startup failure, or the complete esbuild
protocol. There is no automatic pressure experiment or source fix for an
assumed cause.

## Approved next host contract

This supervisor-complete contract is not implemented. The bounded launcher
getter above is a separate observation and makes no complete inventory claim.

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
host implements it. The legacy snapshot getter still returns an array, which
has no authoritative inventory and therefore produces unknown aggregate counters.

## Replay real observations

```sh
source env.sh
bun scripts/replay-engine-lineage.ts RAW_JSONL REPORT_JSON
bun scripts/replay-engine-lineage.ts JSC_RAW_JSONL REPORT_JSON cached
```

The replay requires an explicitly named complete raw getter field. It preserves
all observations, checks that active processes remain present, and rejects any
inferred legacy aggregate. Reports record the input digest and line numbers.
