# Feature-owned check discovery

Add one `checks/<owner>-<feature>.json` file for a new script test or native fixture:

```json
{
  "owner": "runtime",
  "path": "scripts/example.test.ts",
  "localRuntime": true
}
```

Owners are `runtime`, `web`, `quality`, `package-extra`, `cmake`, `web-browser`
and `native`. Native paths name a directory under `tests/fixtures/`. Other paths
name one script test, not a glob or command. The prefix must match the owner.
The runner rejects unknown fields, absent files, symlinks, unsafe paths and duplicate
owners. It sorts by repository path before invoking argv directly, without a shell.
Web manifests also retain the three original subprocess batches with ordered
`batch` labels. A failed batch stops the runner; later batches never run.

`localRuntime` retains the former local `check-runtime.sh` selection. It does not
add a second CI owner. The `runtime` owner runs in the compiled native fixture
job. Use `web` with `localRuntime: true` for source-only Node or Bun checks that
also belong in the local runtime preflight. Their Web gate stays blocking without
building native guests. The native selector reads registered harness paths and
fixture directories from both comparison snapshots, including removed inputs.
Seven overlapping probes belong to Web CI only; Web also
owns the runtime type project. The native fixture runner sets `BUN_WASM_CI_CHECKS=1`
so `test.sh` runs only Rust-owned probes, without repeating those Web checks.
Local fixture commands still run their original complete runtime preflight.

Package tests and Web's own test directory keep their existing narrow globs.
Do not also register those files. Browser matrix jobs, deadlines, environment,
engine selection, cache inputs, conditional gates and shared artifact producers
stay in their existing scripts and workflow steps. The CMake probe remains after
its prerequisite step. No discovered native fixture can request a rebuild.

```sh
source env.sh
bun scripts/test-checks.ts runtime --list
bun scripts/test-checks.ts native --list
bun scripts/migrations/discover-checks.ts --check
bun test scripts/test-checks.test.ts scripts/ci-quality.test.ts
```

The migration proof reads the immutable old command lines from Git and compares
the selected sets and owners. It checks all original entries, while allowing new
feature-owned tests. It also checks that the two automatic directory commands
stay unchanged. `--write` recreates the original feature manifests. It does not
remove later additions. New script tests must have a manifest; pre-existing
non-CI probes are not silently added to CI.

Feature PRs also run `scripts/feature-versions.ts <base-sha> <head-sha>` in quality
CI. It rejects package, Cargo and local lockfile version churn. Release and
required consumer-pin PRs use their corresponding `release` or `consumer-pin`
label to identify the deliberate exception. No label is needed for feature work.
