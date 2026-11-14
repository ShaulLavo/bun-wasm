# Web browser shard measurements

Status: Historical measurements from November 13, 2026. The measured-limit policy
below was retired on November 14 under the owner's outcome-first test rule.

## Current hang policy

Every discovered batch receives the same five-minute command hang cap, including
new batches and the default batch. The ten-minute job still includes setup and
cleanup. `scripts/ci-web-browser-shards.ts` contains no measured-limit mapping.
Bun's normal reporter records durations, and the existing command supervisor
preserves nonzero outcomes, process-tree diagnostics, interruption and descendant
cleanup. Individual test and hook caps are separate and remain unchanged here.
The observations below are historical reports, not correctness thresholds or
instructions to recalibrate a batch after a slow run.

## Historical rollout

PR 657's [hosted Web host job](https://github.com/ShaulLavo/bun-wasm/actions/runs/43461758984/job/132016209809)
hit the unchanged 300-second command deadline with 31 of 33 file groups complete.
Sandbox readiness was interrupted and the storage-index file had not started.
The retained log is
`/work/reports/wave-20261112/engines-active/j11-atomicity/current-ci/ae410-web-host.log`.
Its selected paths match all 33 current manifests.

At measurement time, the manifests allocated ten interface files, eighteen preview
files and five lifecycle files. `ci-web-browser-shards.ts` discovered those batches
and supplied the former matrix deadlines. The matrix had `fail-fast: false` and no concurrency cap.
The existing Web host guard requires successful unit and matrix results before
running the original smoke commands once. The eleven required branch contexts
and all test assertions and individual deadlines stay unchanged.

## Complete local command measurements

The isolated worktree started clean and was advanced from `dac56d021` to
`da6829bbbc76f2dbb2099798a468669ed2237d54` before editing. The measured test and
manifest changes are at `f2e5921a5`. Measurement used Bun 1.4.4, Node 26.12.1,
the existing Playwright browser cache and the PC heavy runner's browser class.
The commands ran sequentially on the PC, with no heavy job present at admission.
These are actual full-shard command wall times, not hosted-run predictions.
Light source checks overlapped part of the run, so the PC timings are not a quiet
performance benchmark. Each hosted shard gets its own Ubuntu runner.

| Batch | Files | Full PC command seconds | Results | CI deadline seconds |
| --- | ---: | ---: | --- | ---: |
| `10-interface` | 10 | 92.058 | 89 pass, 1 existing skip | 143 |
| `20-preview` | 18 | 67.026 | 70 pass | 123 |
| `30-lifecycle` | 5 | 78.146 | 24 pass | 98 |

All commands exited zero. Sandbox readiness completed all twelve checks. Its
previously unprinted WebKit failures and deadlines checks took 6.08943 and
1.50770 seconds locally. The storage-index check took 5.15111 seconds and passed.

## Historical deadline calculation and limits

All three shards completed successfully in [PR CI run 43468007947](https://github.com/ShaulLavo/bun-wasm/actions/runs/43468007947)
on source `9ce67b0a0bb64593f604d22fd8d879c150af79bf`. Each shard used a separate
GitHub-hosted Ubuntu runner, Bun 1.4.4 and the existing browser setup. All 33 files
ran once, with 183 passing tests and the same existing skip.

Measure each command from its workflow log's `Run bun ...run-with-timeout.mts`
group to the next action's start. This interval includes startup, tests and
command cleanup, with a small upper margin for the transition to the next action.
Round that measured interval up to the next millisecond for the reference.
The command bounds are `ceil(reference * 1.125)`; test deadlines and assertions
remain unchanged.

| Batch | Hosted job | Log interval seconds | Reference seconds | Bound seconds | Margin |
| --- | ---: | ---: | ---: | ---: | ---: |
| `10-interface` | [132034773867](https://github.com/ShaulLavo/bun-wasm/actions/runs/43468007947/job/132034773867) | 111.683085 | See slower observation below | 143 | See below |
| `20-preview` | [132034773910](https://github.com/ShaulLavo/bun-wasm/actions/runs/43468007947/job/132034773910) | 92.312170 | See slower observation below | 123 | See below |
| `30-lifecycle` | [132034773941](https://github.com/ShaulLavo/bun-wasm/actions/runs/43468007947/job/132034773941) | 86.501588 | 86.502 | 98 | 13.29% |

The raw hosted logs are retained as `hosted-interface.log`, `hosted-preview.log`
and `hosted-lifecycle.log` in the report directory. These complete hosted
measurements replace the initial references assembled from the interrupted
batch's file intervals and local completions. They are observations from one
normal run, not a controlled performance benchmark or a guarantee of future
runner speed.

The next [preview job](https://github.com/ShaulLavo/bun-wasm/actions/runs/43469715842/job/132041820362)
hit its 104-second command limit without a failed assertion. WebKit's `failures`
check passed at 10.647 seconds, but its final `deadlines` check and the storage
file had not completed. The previous complete hosted sample measured those
remaining checks at 1.793 and 2.777 seconds. Add them to the observed 104-second
lower bound, then round up to 109 seconds for startup and cleanup. The preview
bound is now `ceil(109 * 1.125) = 123` seconds. This reference combines the slow
observation with measured remaining work; it is not another complete shard
measurement. Retain the failed run as evidence and confirm a complete hosted
pass with the new bound. Its raw log is `calibrated-preview-failure.log` in the
report directory. Other shard references remain unchanged.

The later [interface job](https://github.com/ShaulLavo/bun-wasm/actions/runs/43471785469/job/132048504451)
printed all 89 passing tests and the existing skip at 126 seconds, just as the
command deadline fired. The job exited 124 and Web host correctly failed its
prerequisite guard. No assertion failed. Use that slower observation rounded
to 127 seconds to include command cleanup; the interface bound becomes
`ceil(127 * 1.125) = 143` seconds. Its raw log is `interface-third-run.log`.
Preview and lifecycle passed in that same run. Keep all observations and
confirm normal completion under the final bounds without changing assertions,
test deadlines, allocation or the aggregate guard.

## Reproduction and cleanup

Source `env.sh`, then run each name from
`bun scripts/test-checks.ts web-browser --batches` through
`bun scripts/run-with-timeout.mts 300 bun scripts/test-checks.ts web-browser --batch NAME`.
Use `bun scripts/ci-web-browser-shards.ts` for the current CI matrix and hang caps.
Run browser commands through the heavy runner on the PC. Use a fresh short
`/work/tmp/bws-*` directory for `TMPDIR`, with an EXIT trap that removes it after
the owned command and browser processes stop.

Full local logs, shell wall times, hosted per-file timing extraction and check
results are retained in `/work/reports/bun-wasm-web-browser-shards/`. Test harnesses
own their process and scratch teardown; the outer timeout also owns detached
descendants. No runtime guest build, service, route, container or browser download
was created. Worktree-local installed dependencies are removed after validation.
Shared browser and package caches retain their existing owners.
The final host check found no worktree dependency directories, measurement
scratch, or processes referencing this worktree or its measurement scratch. The
heavy runner had no active or waiting jobs. The retained report directory is
1.3 MiB of timing and validation evidence; the parent coordinator owns its removal
after review and merge.

Validation passed with `bun run quality --javascript`, actionlint 1.7.12 with
ShellCheck 0.11.0, `bash -n scripts/test-web-host.sh`, and
`bun scripts/migrations/discover-checks.ts --check`. The final quality probes
passed 3,980 tests with one existing skip across 183 files. The live branch
protection API still lists the same eleven required contexts, including Web host.
