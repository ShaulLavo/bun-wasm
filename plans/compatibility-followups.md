# Compatibility follow-ups

Status: Approved

## YAML stress tests can exhaust the WASM engine stack

The unchanged main artifact and the compatibility branch both exit 134 while
running `js/bun/yaml/yaml.test.ts` with the upstream runner. Before the snapshot
matchers the file reports 588 passes and 673 failures; after them it reports
1,261 passes and no assertion failures, then traps before the final report.
Neither run is a fully passing file. Both use a 15-second file limit and a
2-second test limit, and both trap rather than time out.

Reproduce after installing the pinned supplemental dependencies:

```sh
source env.sh
scripts/bun-suite.sh --network loopback --jobs 1 \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output /work/tmp/bun-wasm-yaml-stack-control.json js/bun/yaml/yaml.test.ts
```

Evidence is retained in `/work/reports/bun-wasm-compat-next-2026-10-15/`:
`before.json` and `snapshots-after.json`. The latter contains
`wasm trap: call stack exhausted`, with `JS_ArraySpeciesCreate`,
`js_array_every` and repeated `JS_CallInternal` frames. Snapshot comparison
failures and the runner deadline are ruled out as the cause: the original
artifact also traps, and the fixed snapshot comparisons all pass.

Investigate the two million-node stringify stress cases at
`vendor/bun/test/js/bun/yaml/yaml.test.ts:4310` and `:4323`, then the recursive
`aliases.visit` and `yamlStringify` paths in
`crates/bunwasm-runtime/src/js/formats.js`. These are candidates, not a confirmed
stack trace mapping. Keep the upstream tests unchanged and make excessive depth
throw a catchable error before reaching the engine's WASM call-stack limit.
Verify the exact file on QuickJS, JSC and browser, plus the existing format
fixtures. No suite timeout increase is needed.

## Integration with the separate HTTP/WebSocket lane

`js/node/http/node-http-with-ws.test.ts` changes from 25 failures and a completed
file to 24 observed failures and a 15-second file timeout after real server
async disposal is available. The first error is `Unexpected server response:
200` from `ws/lib/websocket.js:913`; the file expects Node HTTP upgrade support.
HTTP upgrade/WebSocket work belongs to the parallel lane, so no protocol
implementation was added here. Preserve the new close/drain contract when
integrating that lane and rerun this exact file through `scripts/bun-suite.sh`
with the same loopback/dependency arguments above. See `before-extra.json` and
`final.json` in the retained report directory.

The other new timeout in the measured selection is
`js/node/child_process/child_process.test.ts`: it previously stopped during
collection because Bun.semver was missing. It now reaches 26 passes, 55 failures,
4 skips and 1 todo before the file deadline. Its first failure invokes the
unimplemented `ChildProcess.spawn` instance method at line 71. Existing
subprocess/IPC support is a separate follow-up; do not restore the collection
failure to hide it.

## Package-manager cases reached by the portable semver bridge

Status: Approved

Adding `semverIntersects` lets `cli/install/semver.test.ts` register its tests.
Five package-manager cases fail on all three engines. The JSC measurement has
345 passes and five failures in that file, with no timeout. The separate
`regression/issue/08040.test.ts` still passes. Evidence is in
`/work/reports/bun-wasm-track2-2026-10-15/initial-after/`, especially
`jsc-after.json`. These failures are outside the semver host-function bridge.

Reproduce with a clean source reference and rebuilt artifacts:

```sh
source env.sh
bash /work/tmp/wave-heavy/run.sh --class light "serial semver package-manager follow-up" -- \
  env PATH="$PATH" scripts/bun-suite.sh --engine jsc --network loopback --jobs 1 \
  --suite /work/projects/bun-wasm/vendor/bun \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output /work/tmp/bun-wasm-semver-package-manager.json cli/install/semver.test.ts
```

The runner snapshots the reference tree and executes tests in its disposable
copies. It does not run them in the shared checkout. Use a clean reference
because the runner rejects tracked source modifications.

The observed gaps are:

- `bun install --lockfile-only` fails with `error: Unknown install option: --lockfile-only`.
  The cases at upstream lines 1432 and 1673 need normal dependency and override
  resolution while writing only the lockfile. The argument parser currently
  rejects the option at `crates/bunwasm-runtime/src/install/mod.rs:54`.
- A dependency range above `u64::MAX` reports
  `No version matching "^99999999999999999999" found for specifier "foo"`.
  The test at upstream line 1646 expects the suffix ` (but package exists)`.
  `crates/bunwasm-runtime/src/install/resolve.rs:293` drops that distinction even
  though registry metadata was found. The invalid range is already rejected.
- `bun pm version <version> --no-git-tag-version` is not implemented. The two
  cases in the table at upstream lines 1715 and 1730 expect invalid current or requested
  versions to fail without changing `package.json`. They instead reach the
  install option parser and report
  `error: Unknown install option: --no-git-tag-version`.

Implement these in the package-manager track with its existing install fixtures.
Keep the upstream tests unchanged. Rerun the exact file on all three engines.
The portable bridge PR separately fixes the engine-specific Symbol error wording
and browser host GC recursion observed during the initial measurement.

## QuickJS recursion traps before JavaScript can catch the error

The Console comparison reproduces another instance of the stack problem above.
`js/node/console/console-constructor-exception.test.ts` fails unchanged before
and after adding Console on QuickJS. Its self-spawned recursive `exhaust()`
function traps with `wasm trap: call stack exhausted`; the backtrace repeats
`JS_CallInternal`. The child prints no `OK`, and its parent assertion fails.
This happens on every recorded run, without a suite timeout. The other two
console files pass after the Console implementation. JSC passes this recursion
control after the implementation.

Reproduce through the heavy wrapper with the private launcher and rebuilt wasm:

```sh
source env.sh
scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 \
  --launcher "$CARGO_TARGET_DIR/release/bun-wasm" \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output /work/tmp/bun-wasm-console-stack.json \
  js/node/console/console-constructor-exception.test.ts
```

The QuickJS engine requests a 4 MiB engine stack limit in
`crates/bunwasm-runtime/src/engine_quickjs.rs:127`. Check its relation to the
host's Wasm call-stack limit and the linear-memory C stack before choosing
limits. A caught JavaScript RangeError is required; increasing a test deadline
cannot repair an uncatchable Wasm trap. This is outside Console's stream and
constructor implementation. Preserve the unchanged recursive control, also test
plain recursion without Console, and rerun all engine fixtures when changing
stack policy. Before/after evidence is retained in
`/work/reports/bun-wasm-console/console-{before,after}-quickjs.json`.
