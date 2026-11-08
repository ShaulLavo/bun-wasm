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
