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

The combined PR enables the qualified routing observer in ordinary CI through
the existing storage diagnostic build and context. The implementation and
checks are recorded below. Request routing, accepted Document checks and
independent evidence failures keep the same blocking behavior.

## Local verification

Run the changed report/evidence tests three times, storage unit checks, discovery
and CI selection controls, then lint, types, unused code and duplicate checks
through `heavy-runner --host local` with `env.sh`. Do not build a guest, rerun the
full storage workload or capture new browser diagnostics for this retirement.
Component results and cleanup belong in
`/work/reports/goals/storage-ci-20261116/webkit-quarantine-retirement/REPORT.md`.

The latest concrete restart failure is main `d6f19fa9`, run `43736704897`,
job `132905517968`. The replacement document returned 200 and stayed empty and
interactive. `/@vite/client` and `/src/main.ts` had no response, completion or
failure before teardown, while Hono stayed healthy. The unchanged 180-second
readiness hang cap correctly rejected it. The retained report is
`/work/reports/goals/storage-ci-20261114/webkit-d6-restart-forward/REPORT.md`.
Current source cause remains unproved.

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

## Where the preservation scenario's time goes (2026-11-23)

Local PC, headless, `sandbox/dist` from `origin/main` `fc53b0cc4` with a local
`bun-browser.wasm`, browser profiles in the OS temp dir. Each of the 13 template
opens split by the sandbox's own stage marks (summed over the scenario):

| Run | Total | Cold `bun install` | Vite dev start | First preview | Storage open and eviction |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chromium | 91.7 s | 54.1 s | 21.5 s | 9.8 s | 5.2 s |
| Firefox | 85.6 s | 35.3 s | 25.5 s | 9.6 s | 9.7 s |

Nine of the opens are cold installs: `IDLE_INSTALLS_KEPT = 1` evicts the other
Vite template on almost every switch, so vite-react and vite-vue are installed
from scratch three times each and vanilla twice more. A CI runner 2 to 4 times
slower than this PC lands at the reported 218 to 420 s. Eviction itself
(`readSource`, preservation and database delete) costs 0.2 to 0.6 s per open.
The lever is cold install speed (PR 1048's area), not sandbox storage code.

**Open hang (not slowness).** One of four local runs (Chromium, `origin/main`
`fc53b0cc4` build) stopped at `Storage readiness deadline: vanilla` after 180 s, at the
`unsupportedData` restart: `symlink.edit-config` writes `vite.config.ts` while
Vite runs, the old Vite logs `vite.config.ts changed, restarting server...`,
the Restart click kills it, and the new `vite` (pid 10) logs `ready in 1236 ms`.
The preview frame never gets an accepted document: every preview request
answers 502 and Vite logs `Failed to reload /src/main.ts`. `Previews.unregister`
is identity-checked (`web/src/hosted-previews.ts:63`), so a late `stopped` from
the killed run does not drop the new registration. Next step: rerun
`scripts/sandbox-storage-browser.test.ts` with routing observation and read the
`/@vite/client` and `/src/main.ts` hops for the 502's origin.
