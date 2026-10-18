# Browser gate coverage

`source env.sh && bash scripts/test-web.sh` runs the full browser gate. It needs
fresh `dist/bun.wasm`, `dist/bun-jsc.wasm`, `dist/bun-browser.wasm` and
`dist/bun-tools.wasm`. Tests use local fixture servers, not model providers.

Every browser test command has a 300-second deadline. Set
`BROWSER_TEST_TIMEOUT_SECONDS` to change it. A timeout prints the command and its
owned process group and sends SIGTERM so teardown can run. After five seconds it
kills any remaining descendants and returns 124. The gate records failure
and continues with the remaining browser tests. The CLI network cases each have
an independent 60-second deadline.

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

The browser bundle resolver returned logical package symlink paths. Under an
isolated installation, relative imports resolved through the physical cache path.
Bun bundled both paths, duplicating `OutcomeCell` and `TaggedCells`. An
`instanceof` check then treated a control-cell object as a typed array, so process
stop threw inside `Atomics`. Resolving internal relative imports through the same installed package path fixes
the identity at the build boundary. This also preserves support for dotted cache
directory names, which Bun rejects as physical paths returned by a build plugin. Waffle's ABI and class checks need no changes.

These adapters and byte-encoded fixtures are original bun-wasm code. They contain
no copied or adapted upstream implementation.
