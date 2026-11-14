# Feature-owned check discovery

Add one `checks/<owner>-<feature>.json` file for a new script test or native fixture:

```json
{
  "owner": "runtime",
  "path": "scripts/example.test.ts",
  "localRuntime": true
}
```

Owners are `runtime`, `web`, `quality`, `package-extra`, `cmake`, `web-browser`,
`browser-guest` and `native`. `browser-guest` checks serve the playground site built from
the same commit's browser guest (`scripts/browser-guest-site.ts`). CI's rust job builds that
site once from its receipt-verified guest and uploads it with its identities
(`browser-guest-site`). Browser guest batch jobs in Chromium and WebKit download it and pass it
in `BUN_WASM_BROWSER_SITE`; each check verifies the site's closed inventory, guest and
receipt against the checkout before and after the browsers run, and never bundles it again.
A local run without that variable builds a site in scratch from `dist/bun-browser.wasm`.
Split native manifests default to QuickJS and may declare an `engines` array
containing a nonempty, unique subset of `quickjs`, `jsc`, `browser` and `spidermonkey`.
The native runner runs the runtime preflight once, then executes each
declared engine's fixtures without rebuilding guests or increasing fixture-group
concurrency. CI consumes only the producers selected by its explicit
`BUN_WASM_CHECK_ENGINES` subset; missing artifacts for selected engines fail. Without
that subset, local runs consume every declared engine. JSC selections require
its normal producer, including when the
manifest or fixture is removed. Shared-group manifests continue to infer their
engine from their matching producer and cannot declare `engines`.

Native paths name a directory under `tests/fixtures/`. The existing native gate
compares stdout, stderr and the expected exit through `test.sh`. SpiderMonkey
requires an absolute `SPIDERMONKEY_WASM` and runs the interpreter tier. CI includes
that producer in `BUN_WASM_CHECK_ENGINES`. The separate installer matrix and the
installer checks inside runtime preflight use `INSTALL_ENGINES`, retaining their
three supported engines.
Changed targeted fixtures and manifests select JSC from the verified base, head
and merge ancestor, including removals. Missing selected inputs fail the gate.
Native manifests may select `"profile": "shared-group"`; omission
keeps the ordinary split producer and selection. The shared PIC job consumes the
Rust job's launcher and one matching group core/QuickJS pair through
`bun scripts/test-checks.ts native --profile shared-group`. A `browser-guest` manifest may
select the same profile; the same job runs it in Chromium against that group build through
`bun scripts/test-checks.ts browser-guest --profile shared-group`, and the Processes legs keep
the split selection. Missing artifacts or capability fail this blocking gate. Other paths
name one script test, not a glob or command. The prefix must match the owner.
The runner rejects unknown fields, absent files, symlinks, unsafe paths and duplicate
owners. It sorts by repository path before invoking argv directly, without a shell.
Web manifests retain the three original subprocess batches with ordered `batch`
labels. A failed batch stops a local runner before later batches. Browser guest
manifests also accept these labels. CI discovers them with `--batches` and gives
each browser and batch its own runner, selecting it with `--batch NAME`. The
existing required Processes gates wait for every batch and reject failures,
cancellations and unexpected skips. A producer-disabled run skips the guest jobs.
All jobs keep their existing ten-minute budget, and the site is still built once.

`web-browser` manifests select one of three measured `batch` labels. CI uses
`scripts/ci-web-browser-shards.ts` to discover the matrix and command deadlines.
Adding an unmeasured batch fails discovery. Every shard runs in parallel with
`fail-fast: false`, so one failure does not cancel the others. The required
Web host gate rejects any failed, cancelled or skipped shard and unit job before
running its existing smoke checks once. Local `test-web-host.sh --browser` still
runs both the discovered checks and smoke checks; CI uses `--smoke` after shards.

`localRuntime` retains the former local `check-runtime.sh` selection. It does not
add a second CI owner. The `runtime` owner runs in the compiled native fixture
job. Use `web` with `localRuntime: true` for source-only Node or Bun checks that
also belong in the local runtime preflight. Their Web gate stays blocking without
building native guests. The native selector reads registered harness paths and
fixture directories from the verified base, head and their merge ancestor,
including removed inputs. Every snapshot manifest must be a regular file with
valid metadata; empty files and symlinks fail selection.
Browser guest harnesses and their manifests also select the existing Rust producer,
which builds the receipt-verified guest and bundles the site once. A `browser-guest`
manifest may declare `inputs` as a nonempty list of exact repository paths for
feature source or helpers that also need this gate. The selector reads these inputs
from the same three snapshots, including removals. The check keeps its Browser guest
owner and split or shared-group profile. Unrelated Web source and docs stay outside
this producer selection. Source-only `web` checks do not declare producer inputs.
Seven overlapping probes belong to Web CI only; Web also
owns the runtime type project. The native fixture runner sets `BUN_WASM_CI_CHECKS=1`
so `test.sh` runs only Rust-owned probes, without repeating those Web checks.
Local fixture commands still run their original complete runtime preflight.

The native CI step sets `INSTALL_ENGINES` from its ordinary JSC producer selection.
The tarball installer matrix runs QuickJS and Browser, adding JSC only when that
producer is selected. Installer source, fixture, and helper changes select JSC.
`INSTALL_ENGINES` accepts a nonempty comma-separated subset of `quickjs,jsc,browser`
without whitespace, unknown names, or duplicates. It cannot be combined with
`INSTALL_ENGINE` or `BUN_WASM`. Without the subset, the matrix still runs all three
engines, or the singular `INSTALL_ENGINE` with its optional `BUN_WASM` override.
A selected missing artifact fails the check. No file-existence filter changes selection.

Package tests and Web's own test directory keep their existing narrow globs.
Do not also register those files. Browser matrix jobs, deadlines, environment,
producer selection, cache inputs, conditional gates and shared artifact producers
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

## Native probes consume a producer checkpoint

`native-probe` names a script test and a nonempty `inputs` list of exact
repository paths. The native selector reads those paths and their manifest at
the base, head, and merge ancestor, so deleted probes still select prerequisites.
Lightweight `cmake` utilities must not execute a live probe.

The native-quality job records exact host and WASI archive outputs from its
existing Cargo commands. After both original quality gates finish, it links and
inspects the TLS probe once, then packs it in the existing native checkpoint.
The Rust job verifies that checkpoint and the separate producer-output TLS
digest before running `native-probe` once. Missing inputs fail the blocking gate.
The TLS context binds the run, producer attempt, source, compilers, split profile,
SDK, sysroot, actual archive bytes, full link map, symbols, and link commands.
Source fixture tests do not qualify those live controls.
