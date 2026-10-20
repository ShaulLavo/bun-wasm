# Browser gate coverage

`source env.sh && bash scripts/test-web.sh` runs the full browser gate. It needs
fresh `dist/bun.wasm`, `dist/bun-jsc.wasm`, `dist/bun-browser.wasm` and
`dist/bun-tools.wasm`. Tests use local fixture servers, not model providers.

Every browser test command has a 300-second deadline. Set
`BROWSER_TEST_TIMEOUT_SECONDS` to change it. A timeout prints the command and its
owned processes and sends SIGTERM so teardown can run. It remembers each
process's PID and birth identity, including descendants that detach into other
groups. On Linux, an inherited random ownership marker also finds descendants
that outlive a launcher before the next process-tree snapshot. A marked member
also identifies its session leader when that leader no longer exposes the
marker. Only sessions created no earlier than the owned launcher qualify. Every
signal still checks an individual PID and birth identity, never a whole group.

The five-second teardown grace continues after the launcher exits. Remaining
owned processes receive SIGKILL, and the wrapper verifies that none are live
before returning 124. Normal exits and external termination use the same teardown.
The gate records failure and continues with the remaining browser tests. The CLI network cases each have
an independent 60-second deadline.

The unit gate checks a launcher that exits during a descendant's 200ms cleanup
and a launcher that leaves a detached child behind on normal exit. The browser
gate stops a real detached Chromium with SIGSTOP, then checks its removal after
the deadline, abrupt launcher SIGKILL, wrapper SIGTERM and Bun wrapper SIGINT.
Both Node and Bun launcher-failure cases must retain exit 137. The browser cases
keep a separate real Chromium and its launcher alive as unrelated controls.
The Chromium regression runs after browser installation, not in the unit gate.

CI's web host unit gate runs a byte-encoded guest through `web/scripts/run.ts`.
It links the same `runtime_proc` imports as Bun, exercises handled signal delivery
and verifies the default SIGINT exit. No Rust build is needed for this check.

The process browser matrix installs Waffle with Bun's isolated linker. The real
page runner starts foreground guests, stops them with SIGINT and SIGKILL, checks
exit codes 130 and 137, and verifies worker cleanup before the next run. The
resolver unit test independently checks that a package export and a relative
import produce one class identity in the bundle.

## October 18 regression

The process migration in `06e08907` gave all guests direct `runtime_proc` imports.
The CLI comparison shim still supplied only WASI imports. It now shares its
filesystem and descriptor table with Waffle's existing `ProcessABI` and root
`ProcessSupervisor`. The comparison shim has no registered child executables.

The same migration changed the Waffle pin from `5677fc64` to `a0a0f879`.
That brought in the `OutcomeCell` and `TaggedCells` classes added in Waffle
`b1f2b7dd`. These failures predate the libc, immediate-callback and default-guest
changes listed in the incident report.

The browser bundle resolver returned logical package symlink paths. Under an
isolated installation, relative imports resolved through the physical cache path.
Bun bundled both paths, duplicating `OutcomeCell` and `TaggedCells`. An
`instanceof` check then treated a control-cell object as a typed array, so process
stop threw inside `Atomics`. Resolving internal relative imports through the same installed package path fixes
the identity at the build boundary. This also preserves support for dotted cache
directory names, which Bun rejects as physical paths returned by a build plugin. Waffle's ABI and class checks need no changes.

These adapters and byte-encoded fixtures are original bun-wasm code. They contain
no copied or adapted upstream implementation.
