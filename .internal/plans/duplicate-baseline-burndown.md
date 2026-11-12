# Duplicate baseline burndown

Status: Approved. The parent is the scheduling owner for each item below.

This plan records authored duplicate work that remains after the M00 stale-key cleanup. A plan reason is an approved follow-up anchor, not an upstream exception. Each source unit must preserve the behavior and focused checks named here before its integration owner removes the corresponding numeric allowance and reason.

## M01: share timeout-result assertions

Own `scripts/spawn-runtime-proc.test.ts` for fingerprint `7ae2633925a39989`. Extract only the repeated timeout result assertions into a typed local helper. Keep the two distinct timeout-race arrangements, the five-poll assertion, intermediate descriptor checks, exact `kill:9` list, names, and all scenario assertions unchanged. Verify with the existing source-factory test file.

## M02: share Bun build-version metadata

Own `crates/bunwasm-jsc/build.rs`, `crates/bunwasm-runtime/build.rs`, a dependency-free `crates/bun_version.rs`, and its focused source test for fingerprint `f3e9976f51876be5`. Move the exact package-version substring reader and cargo version emission behind the shared source module. Preserve the `0.0.0` fallback, rerun directive, runtime Git revision handling, dependencies, and version records.

## M03: share the HMR frame reader

Own `scripts/test-dev-cache.mjs`, `scripts/test-hmr-server.mjs`, `scripts/hmr-frame-reader.ts`, and its focused test for fingerprint `6441e6aa7f059159`. The helper owns frame collection and typed `next` waiting; each caller continues to own socket construction, module-level assignment, close behavior, and its timeout diagnostic. Use fake sockets and injected time/waiting in the unit test; do not convert the runners wholesale or run guest HMR tests for this unit.

## M04: share executor poll bootstrap wiring

Own `web/tests/bun-executor.test.ts` for fingerprint `c42db0df7f590c4e`. Add one typed local helper that owns the in-memory `preopen` override and release, `executor.setup`, and linked-poll import capture. Preserve both real run callbacks, descriptors, WASI, readiness/death behavior, `finally` restoration, and MessagePort cleanup. Verify the pinned Waffle poll scenarios before removing the allowance.

## D01: share local error formatting without module cycles

Own `crates/bunwasm-runtime/src/js/{assert,util,events}.ts`, their declarations if required, `scripts/runtime-assert-util.test.ts`, `scripts/runtime-events.test.ts`, and a narrowly named internal factory. The live fingerprints are `432876565c1cd6b7` and `f35a9b37be0e8d3c`. Characterize exact error text, negative zero, long strings, quote selection, constructor getters, thrown getter identity, object inspection, and inspector failure. Keep `events.inspect` fallback and the differing depth policies. Choose one internal owner with explicit inspector and policy inputs without introducing a factory cycle, then run source-factory controls before engine acceptance.

## D03: model loader types once

Own `crates/bunwasm-runtime/src/transpiler.rs`, `crates/bunwasm-transpiler/src/lib.rs`, `crates/bunwasm-cli/src/main.rs`, and a dependency-neutral owner for fingerprint `bf6ffaf3957ce426`. Characterize all loader variants and distinct `from_path` fallbacks, share the local domain enum at a neutral layer, keep the final Bun AST conversion in the transpiler, and delete the CLI conversion. Do not add a runtime dependency on Bun AST, parse debug strings, or cast between enums.

## D04: own browser runner child-start behavior once

Own `web/tests/browser-net.mjs`, `web/tests/playground.mjs`, and a typed helper with tests for fingerprint `e871ba083982025e`. Characterize split stdout readiness, regex matches across chunks, early error/exit, no readiness, and ownership registration before moving the code. Preserve browser-net's awaited child cleanup and playground's synchronous exit fallback. Use tiny real child processes for helper proof; no browser is required.

## D05: share browser-test cleanup with launch-in-flight proof

Own `web/tests/browser-smoke.mjs` and `web/tests/browser-splitting.mjs` for fingerprint `59a6a46ccf0c0efe`. Preserve pending-launch waits, cleanup-only launch rejection handling, browser-before-server close order, `finally` scratch removal, idempotent cleanup, SIGINT 130, SIGTERM 143, and independent 60-second deadlines. Prove resource-promise lifecycle behavior before wiring real callers.

## D06: revisit the minimal Remix page binding

Own `sandbox/src/app.tsx` and `web/src/playground/app.tsx` for fingerprint `887d24fd0e8ffb40`. Compare removing only the repeated model-to-handle subscription with leaving independent render functions. Preserve each model, `handle.signal` teardown, pane DOM identity, and the shipped page structure. If a generic wrapper has no payoff, record the owner decision rather than inventing an exception.

## D07: remove the hidden cross-format encoding copy

This debt is no longer represented by a live baseline key after stale fingerprint `62b11766d46330cc` is removed. Own `buffer.js:140-165` and `string_decoder.ts:15-40` in the runtime JS directory. Unify the normalizer behind a lazy internal owner without a Buffer initialization cycle or changed coercion count. Characterize undefined, null, empty strings, aliases, unknown encodings, side-effectful string conversion, and Symbols while preserving each public boundary's validation and errors.

## D08: finish body getter consolidation

This debt is no longer represented by a live baseline key after stale fingerprint `85cdd83fd20b1ad5` is removed. Own the repeated `bodyUsed` and `body` getters at `web.js:1002-1010` and `1067-1075`. Extend the existing `BodyMixin` owner with descriptors, then remove class copies only after proving receiver identity, null body, lazy stream identity, disturbed and locked states, cloning, and transfer with the body source-factory tests.
