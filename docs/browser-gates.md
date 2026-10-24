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
The Chromium launcher gate runs after browser installation, not in the unit gate.

CI's web host unit gate runs a byte-encoded guest through `web/scripts/run.ts`.
It links the same `runtime_proc` imports as Bun, exercises handled signal delivery
and verifies the default SIGINT exit. No Rust build is needed for this check.

The process browser matrix installs Waffle with Bun's isolated linker. The real
page runner starts foreground guests, stops them with SIGINT and SIGKILL, checks
exit codes 130 and 137, and verifies worker cleanup before the next run. The
resolver unit test independently checks that a package export and a relative
import produce one class identity in the bundle.

## Package identity in the browser bundle

The browser bundle resolver resolves internal relative imports through the same installed package path as the package import. Under an isolated installation a logical symlink path and the physical cache path would otherwise both be bundled, which duplicates Waffle's `OutcomeCell` and `TaggedCells` classes and breaks their `instanceof` checks. The process browser matrix above guards this.

The CLI comparison shim shares its filesystem and descriptor table with Waffle's `ProcessABI` and root `ProcessSupervisor`, and has no registered child executables, because every guest imports `runtime_proc` directly.

These adapters and byte-encoded fixtures are original bun-wasm code. They contain
no copied or adapted upstream implementation.
