# Canonical engine closures

The producer builds one generic core for a selected profile and composes it with
the admitted engine sides. It never rebuilds native VM libraries implicitly.
Use a clean, exclusive checkout and an explicit new output root.

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

The Hermes VM receipt identifies `sha256`, `bytes` and `shimSha256`. Archive bytes
and the current shim must match. A changed shim requires a matching native
generation, even if an older archive exists. The native library owner must also
admit its complete source/header/tool/flag closure before production.

The producer builds one launcher with the existing pinned Cargo host recipe and
records its source, command and exact binary identity. To admit an existing
launcher instead, set `BUN_WASM_LAUNCHER` and
`BUN_WASM_LAUNCHER_RECEIPT`; the original receipt must match the current source
and executable bytes. The staged launcher and receipt are part of the manifest.

## Shared-group QuickJS

Set both sysroot variables before sourcing `env.sh`:

```sh
export BUN_WASM_SHARED_SYSROOT=/absolute/admitted/shared-pic/sysroot
export BUN_WASM_SYSROOT=$BUN_WASM_SHARED_SYSROOT
source env.sh
export BUN_WASM_ENGINE_ROOT=/absolute/different/output
bun scripts/engine-producer.ts build shared-group
bun scripts/engine-producer.ts verify shared-group
```

This profile admits only QuickJS. It records the imported shared-memory profile,
build-std source inputs and original core/side receipts, checks that no stock C++
runtime member was selected, and runs the native `worker-alias.ts` proof.
It does not qualify JSC, Hermes, browser shared workers, a memory-limit change or
a full application. Split and shared-group outputs never verify against each
other. No capacity or runtime policy is selected by this producer interface.

For manual composition, `guest-build-receipt.ts inputs quickjs shared-group`
records the explicit profile. `write ARTIFACT INPUTS_FILE` takes the profile from
that snapshot; a write-time override is refused. Split inputs omit the field.

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
