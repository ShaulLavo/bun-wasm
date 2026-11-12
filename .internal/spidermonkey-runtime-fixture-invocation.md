# Experimental SpiderMonkey native fixture invocation

Status: Approved source-only invocation support. No matching side/core/launcher,
hello, G3 execution, or admission is claimed by the synthetic controls.

After the coordinator accepts matching bytes, use the existing fixture runner.
The native host loads ProgramFiles from the explicit core and its fixed sibling
`spidermonkey-engine.wasm`. It validates the linked profile. This runner checks
input presence, not source provenance or admission. Keep the accepted input
paths and hashes with the real run's evidence.

```sh
source env.sh
# Set these to coordinator-accepted artifacts, not old dist files.
export BUN_WASM_LAUNCHER=/accepted/native/bun-wasm
export BUN_WASM_SHELL=/accepted/shell/bash-web-shell.wasm
export BUN_WASM_ENV_UTILITY=/accepted/shell/bash-web-env.wasm
core=/accepted/program/bun-spidermonkey.wasm

# The maintained hello-equivalent fixture evaluates a minimal script.
scripts/test.sh --engine spidermonkey --wasm "$core" --tier interp cli-eval
scripts/test.sh --engine spidermonkey --wasm "$core" --tier pbl cli-eval

# Then select the G3 fixture cases. Each tier is a separate invocation.
scripts/test.sh --engine spidermonkey --wasm "$core" --tier interp \
  cli-eval engine-modules esm-async-dependency-reimport cjs-interop \
  net-serve self-spawn async-local-storage errors-rejection \
  promise-rejection-identity host-gc-capture array-buffer-sink-detached stack-overflow
scripts/test.sh --engine spidermonkey --wasm "$core" --tier pbl \
  cli-eval engine-modules esm-async-dependency-reimport cjs-interop \
  net-serve self-spawn async-local-storage errors-rejection \
  promise-rejection-identity host-gc-capture array-buffer-sink-detached stack-overflow
```

`--tier` is mandatory and only accepts `interp` or `pbl`. It sets the launcher
child's environment and the guest's explicit `--env` entry. Guest subprocesses
use that environment and the registered `/opt/bun/spidermonkey/bin` executable.
An ambient tier cannot replace the selector. No global tier is changed.

Experimental invocations never run runtime preflight, builds, the producer,
receipt helpers, or initializers. `--no-build` is optional because the branch
always disables builds. `--update` is rejected. QuickJS, JSC and Browser retain
their original selection, build and preflight defaults.

Every ordinary fixture runs in a fresh scratch copy with its cmd, args, stdin,
show files, normalized complete stdout, expected stderr, and exit comparison.
Absent expected stderr means empty stderr for experimental runs. Failures keep
the full diff and stderr in the command output. The summary counts all selected
cases, including timeouts and unsupported specialized probes. Capture the full
command output and exit status for real evidence. The deadline sends TERM at
60 seconds and KILL after another 5 seconds. Signal teardown stops the active
process group and test server before removing scratch.

Six existing specialized probes remain explicit failures for SpiderMonkey:
`http-response-lifecycle`, `worker-review`, `fs-empty-read`, `stdout-busy-loop`,
`fs-writev-partial`, and `pipe-closed-output`. Their own scripts need an explicit
program/tier contract, not an engine relabel or a fallback to dist. Extending
those files is outside this task. Full-suite success is not claimed. The native
C++ semantics driver and the unresolved arbitrary negative classic-script offset
contract also remain separate gates. This note does not replace the full G3
coverage list or waive any required runtime gate.

## Bounded cancellation-check observation, November 8

The parent's JavaScript quality run at `b0b2f5851abe475d12b0b8639688ea0c34457fac`
passed 2,254 probes but failed the existing `SIGTERM stops the active fixture
child before removing its scratch` check. Exit 143 matched. The immediate
`process.kill(pid, 0)` presence assertion did not throw. The failed process's
state was not captured, so a live survivor versus delayed reaping is unproved.

Two bounded focused controls with process-state readback both passed without
changing the fixture, deadline, or assertion. The complete integration review
had also passed this source suite. Treat this observation as not reproduced,
retain it rather than attribute a cause, and require a normal green final CI
run before merge. Do not add a sleep, broaden the deadline, accept live PIDs,
or hide diagnostics to make it pass.

Commands and the original failure are retained under
`/work/reports/wave-20261108/engines/spidermonkey-review-reconciliation/`:
`javascript-quality.log`, `sigterm-control-1.log`, `sigterm-control-2.log`, and
`pid-readback.ts`. The normal discovered owner remains blocking. If it fails
again, capture that PID's actual state and parent before fixture teardown.

## Ignored-TERM process ownership follow-up, November 8

Status: Approved follow-up. Diagnosis recorded, no runtime or test fix claimed.

The Astro quality failure is preserved in
`/work/reports/goals/astro-angular/integration/astro-quality-initial-failed.log`.
The original `astro-quality.log` path now contains a later run. The failure
passed the expected exit and failed-fixture summary checks, then failed the
immediate PID-presence assertion at test line 318 after 229.63 ms. It recorded
no process state, parent, or start time. Its live-process versus zombie versus
PID-reuse cause remains unknown. Independent unchanged-source controls passed
at 230.84 ms and 229.07 ms. Do not repeat the full quality gate for this note.

At source `284679aab5e919d8260a5a0d820916c799cb2307`, `scripts/test.sh:388-395`
executes GNU `timeout` as its direct child, waits for that monitor, then clears
`child_pid`. The launcher is the monitor's child. The EXIT trap at lines 143-152
waits only for a still-recorded monitor and server before deleting scratch.
It cannot reap a launcher adopted by a different process. The test's synchronous
invocation is not in its asynchronous `children` set. Removing directories is
not proof that an orphan was reaped.

One purpose-built control retained ownership through Linux
`PR_SET_CHILD_SUBREAPER`. It ran an instrumented temporary copy of the same test,
without changing deadlines or the original assertion. Instrumentation only
recorded the launcher's original `/proc/self/stat` and its state before the
assertion. The supervisor deliberately deferred adopted-child reaping until
after the assertion. This changed adoption, not signal delivery or timing.

The assertion failed at 238.10 ms. PID 3523604 kept start time 40564480, changed
from running under timeout PID 3523603 to zombie state under supervisor PID
3523572, and had exit signal 9. The supervisor's `waitpid` returned status 9.
The control therefore demonstrates a dead, unreaped launcher, not a live leak
or PID reuse. It proves that this assertion can fail after successful KILL,
not that the original quality failure had the same cause. GNU coreutils 9.12's
installed manual also documents that KILL can terminate timeout itself.

The report and reproducible control are retained at
`/work/reports/goals/engines/spidermonkey-ignored-term-20261108/`. To reproduce:

```sh
source env.sh
bun /work/heavy-runner/current/run.js --class light --host local \
  sm-ignored-term-owned-orphan -- python3 \
  /work/reports/goals/engines/spidermonkey-ignored-term-20261108/control.py "$PWD"
```

The wrapper succeeds only if the unchanged inner test fails on a same-identity
SIGKILL zombie and cleanup leaves no descendants or scratch. No production
fix or regression test was added. Keep the 60-second TERM deadline, 5-second
escalation, test's 0.1-second controls, presence assertion, and failed-fixture
accounting unchanged. `--foreground` alone is not a justified fix: its manual
explicitly excludes command descendants from timeout handling.

Next step: capture the same start-time, state, parent, and exit-status fields
immediately before the assertion during the next already-scheduled normal gate.
Do not retry signal 0 or increase a deadline. If that identifies a live survivor,
fix the signal and ownership path. If it identifies a zombie, evaluate a scoped
supervisor that remains alive to reap the launcher and owns its descendants.
Prove both ignored-TERM and cancellation behavior before changing the runner.
A process-wide subreaper in the shared Bun test runner could adopt unrelated
children and is not an acceptable shortcut.

The control reaped its launcher, removed its scratch, and verified no remaining
descendants on the PC. Protected PIDs 4640 and 1506124 remained present. No guest,
engine, addon, browser, device, cache, sysroot, service, or route changed.
