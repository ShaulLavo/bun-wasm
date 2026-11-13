# Web browser shard measurements

Status: Approved. Measured on November 13, 2026.

PR 657's [hosted Web host job](https://github.com/ShaulLavo/bun-wasm/actions/runs/43461758984/job/132016209809)
hit the unchanged 300-second command deadline with 31 of 33 file groups complete.
Sandbox readiness was interrupted and the storage-index file had not started.
The retained log is
`/work/reports/wave-20261112/engines-active/j11-atomicity/current-ci/ae410-web-host.log`.
Its selected paths match all 33 current manifests.

The manifests now allocate ten interface files, eighteen preview files and five
lifecycle files. `ci-web-browser-shards.ts` discovers those batches and supplies
the matrix deadlines. The matrix has `fail-fast: false` and no concurrency cap.
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
| `10-interface` | 10 | 92.058 | 89 pass, 1 existing skip | 127 |
| `20-preview` | 18 | 67.026 | 70 pass | 113 |
| `30-lifecycle` | 5 | 78.146 | 24 pass | 114 |

All commands exited zero. Sandbox readiness completed all twelve checks. Its
previously unprinted WebKit failures and deadlines checks took 6.08943 and
1.50770 seconds locally. The storage-index check took 5.15111 seconds and passed.

## Deadline calculation and limits

PC timings alone would underbudget the slower hosted runner. Attribute the
hosted interval from each file's group start to the next group start to that
file's manifest batch, ending the final partial interval at the deadline log.
This includes inter-group work that the completed-group wall totals omit.
Those observed intervals sum to 299.969798 seconds. Add the observed 0.374-second
step-to-first-group startup separately to each shard.

| Batch | Hosted intervals seconds | Local completion supplement seconds | Reference seconds | Margin |
| --- | ---: | ---: | ---: | ---: |
| `10-interface` | 112.494944 | 0 | 112.869 | 12.52% |
| `20-preview` | 86.723623 | 12.74824 | 99.846 | 13.17% |
| `30-lifecycle` | 100.751231 | 0 | 101.125 | 12.73% |

The preview supplement is the two previously unprinted WebKit checks plus the
entire storage-index check. It conservatively includes the full local failures
check even though the hosted log had already spent 3.117 seconds after its last
printed result. The references exceed the complete local shard measurements.
Deadlines use `ceil(reference * 1.125)` and remain below 300 seconds. The preview
reference combines a partial hosted observation with local completions; it is
not a measured full hosted shard. Complete hosted matrix timings remain to be
confirmed by the PR run. If that runner's measured complete shards require
recalibration, update this evidence and the references without changing any
test deadline or assertion.

## Reproduction and cleanup

Source `env.sh`, then run each name from
`bun scripts/test-checks.ts web-browser --batches` through
`bun scripts/run-with-timeout.mts 300 bun scripts/test-checks.ts web-browser --batch NAME`.
Use `bun scripts/ci-web-browser-shards.ts` for the final CI matrix and deadlines.
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
