# Canonical engine closures

The producer builds one generic core for a selected profile and composes it with
the admitted engine sides. It never rebuilds native VM libraries implicitly.
Use a clean, exclusive checkout and an explicit new output root.

## Mandatory production driver entry

The sole producer owner must use this entry command for both fresh driver
preparation and execution. Set the three absolute paths first. The report's
parent must already exist; the report itself must not exist, even as an empty
directory or dangling symlink.

```sh
node "$GUARD_CHECKOUT/scripts/producer-start.ts" \
  --report-root "$FRESH_REPORT_ROOT" -- \
  "$(command -v node)" "$FRESH_DRIVER_PREPARER"
```

`GUARD_CHECKOUT` is the checkout containing the reviewed orchestration guard.
`FRESH_DRIVER_PREPARER` is a trusted TypeScript preparation entry outside all
historical report and artifact roots. It prepares the new controller/config and
then runs that controller in the same invocation. It must take its report root
from `process.env.BUN_WASM_PRODUCER_REPORT_ROOT`, which the guard sets, rather
than hard-code a previous root or load a previous report's environment/helper.
The preparation entry must direct every report write, including its failure
records and cleanup records, to that root.

Run the guard with Node.js 24 or later on a POSIX host. It uses one non-recursive,
exclusive `mkdir` before loading or executing any preparation/controller code.
An existing file, directory, symlink or competing claim refuses the invocation
without running preparation or cleanup. Only the winning invocation receives
the root. It replaces itself with the command, preserving its PID, inherited
standard streams, exit status and signal termination without a supervisor.

Do not create the report, write controller/config/evidence files, source a held
report's environment, run its `start.sh`, redirect output into it, or install
report-writing failure/cleanup callbacks before this entry. Put any outer
runner's diagnostics outside report roots. No outer failure handler may clean
up a refused root. This entry guards the report claim, not arbitrary paths in
trusted driver code; artifact custody checks remain mandatory.

The claim stays on success, preparation failure, execution failure and signal
termination. Never remove it automatically or reuse it for another start. Keep
its diagnostics for the owner; use a different brand-new root for an authorized
retry. This command grants no production authorization. It changes orchestration
only, not the approved guest checkout, source/tree tuple, artifacts or pins.

## Engine commands inside the claimed driver

The driver invokes the existing engine commands only after the report claim and
its own custody/setup gates. The example below is not a production start entry.

```sh
source env.sh
export BUN_WASM_ENGINE_ROOT=/absolute/owned/output
export JSC_BUILD_DIR=/absolute/admitted/jsc
export HERMES_BUILD_DIR=/absolute/admitted/hermes
export HERMES_VM_RECEIPT=/absolute/original-vm-receipt.json
bun scripts/engine-producer.ts build split
bun scripts/engine-producer.ts verify split
```

The split registry contains QuickJS, JavaScriptCore and Hermes. The core uses
`engine-split,bun-transpiler,bun-build`. Each side keeps its original component
receipt; each composed guest gets its own build receipt. All three engines run
the native-launcher and Node-host smoke before browser assets and the existing
browser telemetry gate. Missing payloads, receipts or required assets prevent a
reusable manifest. This does not run the full application acceptance suites.

The Hermes VM receipt is the `vm-library.json` that `hermes/check-build.ts` writes
after the native build. It identifies `sha256`, `bytes`, `shimSha256` and
`consumerInputs`: every source and header the compiler read for the shim, from
`ninja -t deps`. Each input records both the compiler path and its resolved
file, so sysroot header aliases are allowed but retargeting them invalidates
the receipt. Archive bytes, the current shim and every consumer input must
match. A changed shim or header requires a matching native generation, even if
an older archive exists; receipts without `consumerInputs` are refused. The
native library owner must also admit its complete source/tool/flag closure
before production.

The producer builds one launcher with the existing pinned Cargo host recipe and
records its source, command and exact binary identity. To admit an existing
launcher instead, set `BUN_WASM_LAUNCHER` and
`BUN_WASM_LAUNCHER_RECEIPT`; the original receipt must match the current source
and executable bytes. The staged launcher and receipt are part of the manifest.

## Shared-group QuickJS is unavailable in this branch

This branch retains the shared-group types and receipt contract, but does not
include the native worker implementation or `tests/shared-group/worker-alias.ts`.
Shared-group build requests fail before input inventory, recipes or launcher work
when the proof fixture is missing. Use this branch for split production only.
Do not bypass the rejection by adding a placeholder proof.

The shared-group contract admits only QuickJS. A qualified closure must record
the imported shared-memory profile, build-std source inputs and original
core/side receipts. It must select no stock C++ runtime member and pass the native
`worker-alias.ts` proof.
It does not qualify JSC, Hermes, browser shared workers, a memory-limit change or
a full application. Split and shared-group outputs never verify against each
other. No capacity or runtime policy is selected by this producer interface.

The retained metadata command `guest-build-receipt.ts inputs quickjs shared-group`
records the explicit profile. It does not enable shared-group production here.
`write ARTIFACT INPUTS_FILE` takes the profile from that snapshot; a write-time
override is refused. Split inputs omit the field.

## Verification and consumers

Verification is read-only, refuses an active producer and checks all required
component/composed receipts, manifest inputs and launcher identities. Building
an already-manifested root performs verification only, without rebuilding or
rewriting its state. Failed new production retains its diagnostic state and
releases the owned lock.

The comparison runner must use the manifest's exact launcher and source identity.
Its source `dist` and `web/dist` staging must resolve to the canonical output's
`dist` and `web`, after all production consumers have stopped. Never stage through
an old frozen checkout. A separately required Browser-native guest must have its
own matching profile and receipt; the three-engine split registry does not
substitute a source-cache-only Browser payload for it.
