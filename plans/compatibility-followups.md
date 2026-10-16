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

## JSC subprocess disposal timing

The ArrayBufferSink campaign exposed a variable result in upstream
`js/bun/spawn/spawn.test.ts`, case `dispose keyword works` at line 1387.
The integrated three-file measurement has five spawn passes and 172 failures.
A spawn-only repeat with identical wasm, launcher, runner and dependency hashes
has six passes and 171 failures. Only the disposal case changes status.
The sink file consistently has 13 passes and one skip. Raw results are retained
in `/work/tmp/bun-wasm-track4-sink-evidence/after-jsc-refreshed.json` and
`jsc-spawn-repeat.json` until coordinator review. The tracked sink report preserves
the counts after those local artifacts are removed.

Reproduce with the sink report's command and `--engine jsc`, selecting only
`js/bun/spawn/spawn.test.ts`, through the heavy wrapper. Trace child completion
before the disposal call in `crates/bunwasm-runtime/src/js/spawn.js:228` and the
signal state set by `kill()` at line 223. The child may already have settled;
that cause remains unconfirmed. No sink code or provenance changed in the repeat.
Keep this subprocess investigation separate from byte-sink behavior.
