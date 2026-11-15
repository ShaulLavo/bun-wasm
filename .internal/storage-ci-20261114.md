# Browser-native storage CI repair

Status: Approved. Owner: storage CI coordinator. Updated: 2026-11-16.

## Retirement decision

Managing approved retiring both remaining WebKit exceptions, config restart and
first vanilla restoration, alongside the removed Firefox Vue CLOSED and React
optimizer exceptions. Exceptions only shrink. This decision supersedes the old
requirement to demonstrate the historical cause before removal. Source review
and green ordinary CI remain required. No separate diagnostic run is requested.

Every future preservation failure is blocking. The report-only helper writes the
complete per-browser protocol and rethrows the identical primary object. Unknown
errors and failed report writes also reject. Reports have no acceptance label,
and the obsolete CI switch, matcher, warning and success summary are removed.
Context, session and progress failures remain independently retained and blocking.

Keep the original successful storage assertions, readiness, accepted Document
oracle, scenario workload and generous hang caps unchanged. Keep the existing CI
owners, selector policy, commands, retries and product pins. The page-load stall
is separate work.

## Retained failed history

The original JSON protocols in `scripts/fixtures/storage-ci/` remain unchanged
and are rejection/report inputs in `scripts/storage-failure-report.test.ts`.

- Firefox Vue CLOSED: PR 738, run 43530616509. Fork reported errno 29 and message
  deserialization failure; Hono stayed ready. Duplicate timestamps in jobs
  132260477153 and 132268805440 do not prove two independent executions.
- WebKit config restart: PR 730, run 43516069702, job 132216974765. Vanilla never
  regained readiness after saving the config; Hono stayed ready. A later hosted
  control passed, which establishes bounded non-reproduction, not a cause.
- WebKit React optimizer: all five original protocols and their run/job metadata
  remain in `webkit-react.json`, including the callback relocation in run
  43566104389. PR 752 proved and repaired a cached WASI view defect, but did not
  establish that it caused these historical failures.
- WebKit first restoration: PR 824, run 43692497763, job 132760205807. Vanilla
  printed ready after eviction but its preview remained empty and unaccepted.
  `webkit-restoration.json` retains its original `preservation` checkpoint; tests
  also replay it at the explicit first-restoration checkpoint.
- Later React reopening: run 43608394922, job 132533226013. Initial readiness
  passed; reopening stalled without a bounds exception, CLOSED error or dev exit.
  This remains a failed scenario, separate from the original optimizer protocol.

The original causes remain unproved. Waffle .135/.136 and PR 849 may have cleared
the failures; passing controls do not establish attribution. Earlier detailed
source and failure reports remain under
`/work/reports/goals/storage-ci-20261114/` and
`/work/reports/goals/stack-exhaustion-20261113/`.

## Routing report requirement

The same combined PR adds the qualified routing observer to ordinary CI. It must
retain request routing, document acceptance and independent observation failures
without changing the product oracle or turning a failure into success. The
routing integration owner will finish this section with its implementation and
checks. This component does not edit that worker's observation or build helpers.

## Local verification

Run the changed report/evidence tests three times, storage unit checks, discovery
and CI selection controls, then lint, types, unused code and duplicate checks
through `heavy-runner --host local` with `env.sh`. Do not build a guest, rerun the
full storage workload or capture new browser diagnostics for this retirement.
Component results and cleanup belong in
`/work/reports/goals/storage-ci-20261116/webkit-quarantine-retirement/REPORT.md`.

## Ordinary routing observation, approved

The integration retires both remaining WebKit exceptions and enables the
qualified observer through the existing storage diagnostic build/context path.
Initial Hono and vanilla traffic in the unchanged preservation case must qualify
actual SW, page, registered server, runtime and real helper request coverage
before config restart. The historical cause remains unproved. The next failure
reports `/@vite/client` and `/src/main.ts` from bounded scalar routing rows,
including late metadata retained after context closure. The summary distinguishes
explicit refusal/error, accepted without headers, and missing or ambiguous hops.
It does not infer a guest transform or filesystem cause from a missing reply.
Routing retention is separate from filesystem causal history. The ordinary
entry-absent hosted validation gate remains blocking. PR 840's page-load stall is
separate and unchanged. Parent owns the single full-source review and normal CI;
no separate diagnostic campaign or full local preservation replay is added.
