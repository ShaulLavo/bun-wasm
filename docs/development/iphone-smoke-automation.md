# Automatic iPhone smoke checks

Status: Approved. Install after review. The watcher enrolls every source revision
with a successfully completed `CI` workflow from a `push` to this repository's
`main` branch. Each revision runs Vite + React with Browser, Hono with Browser,
and Vite + React with QuickJS on native iPhone Safari through render and tap.

## Ownership and execution

`scripts/iphone-smoke-watch.ts tick` polls GitHub through the existing `gh`
login. It writes a durable queue, then uses the supported `t3 thread send --json`
CLI to dispatch one revision to the coordinator. The default coordinator is
`mcp:launch:d5c5eb90071799276e00d53b8b67c40ffef4a1f7b453c759a2d6463dc98733ec`.
Change it with `--dispatch-thread=<thread>` when ownership changes.

The receiving harness turn claims the attempt before starting any work. It builds
the scheduled source locally on the PC through the heavy runner, obtains a fresh
`device_open` command, acquires the existing Mac FIFO, and calls the manual runner.
Use the low-level runner's documented arguments in `scripts/iphone-smoke.ts`:

```sh
bun scripts/iphone-smoke.ts \
  --root=/absolute/prepared-root \
  --output=/absolute/fresh-output \
  --source-file=/absolute/source.json \
  --iphone-control-url=http://127.0.0.1:PORT/__goals_iphone/TOKEN \
  --iphone-agent-command=/exact/device_open/agent-device \
  --device-udid=C4D2_FULL_UDID \
  --mac-thread=FIFO_HOLDER_THREAD
```

The root, guests and assets must come from the scheduled commit. Record that
commit. Local builds are valid; do not wait for CI's build outputs. The low-level
runner does not prepare or deploy a root. Never label the live sandbox as a queued
revision. The harness owns cleanup on both hosts and completes preparation failures
as red, with the phase and a report explaining what failed.

The timer runs no detached device workload. The low-level runner and its manual
deploy procedure are owned separately from this watcher.

## Queue and reports

The default report directory is `/work/reports/goals/iphone-smoke`. Every command
accepts `--report-dir=/absolute/directory`. Linux `flock` serializes commands;
conflict exits 75. `state.json` is the authoritative queue, written with file sync,
atomic rename and directory sync. `STATUS.md` is its human-readable projection.
Both persist pending, running and completed jobs. Attempt evidence lives under
`<report-dir>/<revision>/attempt-N/`.

`--since=<activation UTC>` fixes the first enrollment window by CI run creation
time. It is mandatory on the first tick and cannot change in an existing state
directory. Runs created before activation are outside this window, even if their
CI finishes afterward. The watcher rescans all successful runs in the window.
GitHub pagination and time-window splitting cover its 1,000-result query limit.
There is no newest-success watermark. An older pending CI run that turns green
later, including a successful rerun, still enters the queue. Repeated successes
for the same source produce one job.

Known pending sources dispatch in CI source order. Late successes remain separate
jobs. A failure records the newest tested-green predecessor in that order, never
a newer descendant as its baseline. Before the first tested green, the baseline
and range are explicitly unavailable. This is source selection, not a historical
bisect.

Dispatch is a durable outbox. Failed T3 sends stay pending and retry on the next
tick. A send acknowledged immediately before a crash can be repeated. The atomic
claim rejects duplicate messages before they start a second UI session. Claimed
work survives watcher restarts and requires completion or an explicit audited
retry. No automatic timeout abandons it or starts another simulator job.

Every completed red sends the last tested green, failing green main, compare
range, failed phase and report path to managing thread
`bd2baec7-7e23-49b0-8d20-31486beeb178`. Override it with `--notify-thread=<thread>`.
Failed notifications stay pending. A crash after delivery but before saving can
repeat a notification, which includes revision and attempt for identification.
Dispatch failures also attempt an immediate red operational message. GitHub
discovery failures remain visible in `state.json`, `STATUS.md` and the service log;
already enrolled jobs stay intact.

## Claim, complete and retry

Run these in the reviewed watcher checkout after `source env.sh`. Use the revision
and attempt from the dispatch message:

```sh
bun scripts/iphone-smoke-watch.ts claim \
  --revision=FULL_SHA --attempt=1
```

If claim fails, do no device work. After the runner and verified resource cleanup:

```sh
bun scripts/iphone-smoke-watch.ts complete \
  --revision=FULL_SHA --attempt=1 \
  --result-file=/absolute/attempt-output/result.json
```

The runner's richer result is retained unchanged. Its required completion fields
are `revision`, `status` equal to `green` or `red`, `failedPhase` and an absolute
`reportPath`. A green result requires a null failed phase; a red result requires
a nonempty failed phase. The manual runner also supplies `kind` equal to
`manual-iphone-smoke`, `source`, `cases` and `ownership`. Preparation failures may
use the required fields alone. Never turn missing or failed setup into green.

If interrupted, inspect the attempt's dispatch and report files, audit both hosts,
stop only the attempt's owned resources, and write a cleanup report. Retain it
with the attempt. Then:

```sh
bun scripts/iphone-smoke-watch.ts retry \
  --revision=FULL_SHA --attempt=1 \
  --cleanup-report=/absolute/resource-audit.md
bun scripts/iphone-smoke-watch.ts tick
```

Retry archives the previous state and cleanup report, advances the attempt number,
and dispatches to a fresh attempt directory. Obtain a fresh device session and
FIFO reservation. Stale completion or claim commands cannot change the new attempt.
Pending red notifications must be delivered before retrying a completed result.

Inspect status without polling GitHub or sending a message:

```sh
bun scripts/iphone-smoke-watch.ts status
```

## Installation by the coordinator

Do not modify the existing `bun-wasm-ci-controller.service`. It owns unrelated VM
work. Use a separate user oneshot service and a two-minute timer. Install from a
reviewed checkout retained at a stable `/work` path. The examples below use
`/work/automation/bun-wasm-iphone-smoke`; substitute the actual reviewed path and
the chosen activation timestamp before installation. Confirm `gh api` and
`t3 thread send --help` work in the service user's environment. Reuse their normal
login state; no credentials belong in a unit file or this repository.

`~/.config/systemd/user/bun-wasm-iphone-smoke.service`:

```ini
[Unit]
Description=Schedule bun-wasm main iPhone smoke checks

[Service]
Type=oneshot
WorkingDirectory=/work/automation/bun-wasm-iphone-smoke
ExecStart=/bin/bash -lc 'source env.sh && bun scripts/iphone-smoke-watch.ts tick --since=2026-11-15T12:00:00Z'
TimeoutStartSec=15min
KillMode=control-group
UMask=0077
```

`~/.config/systemd/user/bun-wasm-iphone-smoke.timer`:

```ini
[Unit]
Description=Poll successful bun-wasm main CI every two minutes

[Timer]
OnBootSec=2min
OnUnitInactiveSec=2min
Unit=bun-wasm-iphone-smoke.service

[Install]
WantedBy=timers.target
```

After review, the coordinator installs the two units, runs
`systemctl --user daemon-reload`, and enables the timer with
`systemctl --user enable --now bun-wasm-iphone-smoke.timer`. Check the actual timer,
service journal, persisted queue and first dispatch. Verify a fake red notification
before treating installation as complete. Disabling the timer stops new polls;
it does not cancel a claimed job. Audit and finish that job separately. Preserve
reports when removing the service. The implementation PR does not install or enable
anything.

## Local verification

```sh
source env.sh
bun /work/heavy-runner/current/run.js --host local --class light iphone-watch-tests -- \
  bun test scripts/iphone-smoke-watch/watch.test.ts
```

Tests replace GitHub and T3 with fake adapters and exercise the real CLI in isolated
directories. They cover adjacent and late greens, pagination, filtered query limits,
restart, claim deduplication, interrupted persistence, dispatch and notification
failure, red setup, completion and audited retry. They start no Mac workload and
remove their temporary files and child processes.
