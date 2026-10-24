# Run HTML lifecycle acceptance with qualified guests

This helper consumes build evidence. It does not build, install, repair prerequisites, generate qualifications, or approve a guest. Run it only after the parent integrates the test delta, freezes source, reviews that identity and authorizes final artifact execution. No current guest is qualified by this document.

## Supply the parent's qualification

Prepare one external JSON qualification per engine. Pin its SHA256 separately from the file, using the parent's reviewed build evidence. The helper refuses a modified receipt even if its internal hashes were updated. `scripts/html-lifecycle-acceptance.ts` exports the exact `Qualification` schema. `scripts/html-lifecycle-acceptance.test.ts` contains synthetic schema examples, not reusable artifacts.

Every file identity has an absolute `path`, SHA256 `sha256`, and positive integer `bytes`. The qualification contains:

- `schema: 1`, exact candidate `source: {head, tree}`, `engine`, and ordered Cargo `features`.
- `upstream: {root, pin, head, tree, leakTestSha256}` for the actual patched Bun checkout and unchanged `test/js/workerd/html-rewriter-leak.test.ts`. Both checkouts must be clean. The pin must match `scripts/sync-bun.sh` and be an ancestor of the patched head.
- `html: {source, emitted, polyfills}`. These are the actual Cargo-selected source, `OUT_DIR/runtime-js/html_rewriter.js`, and `OUT_DIR/polyfills.rs`. An override source must equal the frozen adapter bytes. The include path must select that exact emitted file. The complete emitted bytes must occur in both raw and executed guests.
- `rawGuest`, `executedGuest`, and `launcher`. For QuickJS and JSC, the launcher is the matching native runtime_proc host. For browser, it is the qualified Node executable. Browser host sources and installed Waffle source/generated dependencies belong in the native-input manifest.
- `nativeInputs`, a file identity for an external JSON array of file identities with an additional `role`. Include the complete actual native/toolchain/dependency/generated-input closure or its qualified content manifests, not just a convenient subset.
- `buildEvidence`, a file identity for the externally qualified build/link/finalization statement below.

The native-input manifest requires `toolchain`, `sysroot`, `crypto-native`, `crypto-wasi`, `engine`, `cargo-selection`, `linkage`, and `guest-build-receipt`. The guest sidecar must match the executed guest bytes, patched Bun head/tree and the `sysroot` receipt hash. Each role identifies real retained inputs or a qualified manifest/receipt of them. Record actual compiler/SDK versions, sysroot builder receipt, separate native/WASI BoringSSL receipts, engine source and feature selection, Cargo-selected build output, and link/finalization logs. For browser, also supply `browser-host` and `waffle`. The exported `trackedNativeInputs` map requires matching frozen Rust parser/native installation, testing export, runtime build/emitter, Cargo lock/config and toolchain source hashes. The map is a minimum, not the full native dependency closure.

For JSC also supply `jsc-stamp` and `jsc-authoritative-check`. Before final execution, the parent must run its candidate's authoritative `jsc/common.sh:check_jsc_inputs_stamp` with the actual build environment, read-only against the shared prerequisite tree. Retain a check statement with `{directory, source: {head, tree}, helper: "jsc/common.sh:check_jsc_inputs_stamp", exit: 0, stampSha256}`. `directory` is the actual prerequisite root; `stampSha256` is the SHA256 of its `build/jsc/.bunwasm-inputs` file. Admission checks the statement's identity, source, successful result and stamp binding. It does not run that helper or rebuild prerequisites. Include the full effective input manifests in the native closure so changes after the check are rejected. Shared JSC stays read-only; Cargo targets stay outside it.

The build statement records:

- `source: {head, tree}`, `engine`, ordered `features`, actual build `command` array, `cargoOutDir`, and `jsOverrideDir` as an absolute path or `null`.
- `rawGuestSha256`, `executedGuestSha256`, `launcherSha256`, `htmlSourceSha256`, `htmlEmittedSha256`, `polyfillsSha256`, and `nativeInputsSha256`.

The parent must derive this statement from the one authorized final build's actual input selection and logs. It must establish that the selected Cargo output/native closure produced the raw guest and that recorded finalization produced the executed guest. Existing `.build.json` sidecars remain required build evidence, but alone they do not bind complete runtime/native source. A matching HTML substring alone is also insufficient. This consumer validates consistency and bytes against the independently pinned statement. It cannot prove an invented build history or qualify its own synthetic unit inputs.

## Admit and run without rebuilding

Set `QUALIFICATION`, `QUALIFICATION_SHA256`, `ENGINE`, `OUTPUT`, and `SCRATCH_ROOT` to the parent's retained qualification, separately verified digest, engine, new report directory, and owned scratch parent. Use `quickjs`, `jsc`, or `browser`. Paths must be absolute. Keep output outside either source checkout. Run from the clean integrated checkout under the execution host's canonical queue, with availability checked before and after admission.

```sh
source env.sh
bun scripts/html-lifecycle-acceptance.ts admit "$ENGINE" "$QUALIFICATION" "$QUALIFICATION_SHA256" "$OUTPUT" "$SCRATCH_ROOT"
# Only after explicit parent execution authorization, inside its canonical job:
bun scripts/html-lifecycle-acceptance.ts run "$ENGINE" "$QUALIFICATION" "$QUALIFICATION_SHA256" "$OUTPUT" "$SCRATCH_ROOT"
```

Admission alone reads files and Git identity. Run mode creates a unique scratch directory with explicit `BUN_WASM_CACHE_DIR`, `XDG_CACHE_HOME`, `TMPDIR`, `TMP`, `TEMP`, `RUNNER_TEMP`, and an unused Cargo target. `ownership.json` records paths before any guest command. Existing process-tree supervision stops/reaps owned descendants before removing scratch, including interruption and failed commands. No new deadline wraps the matrix. Existing fixture limits remain unchanged. `OUTPUT` must not exist, so stale logs cannot be reused. Qualification is checked before both phases and after execution. Artifacts remain external and read-only. A changed artifact, source, emitted payload, or native input aborts the run rather than producing acceptance.

The existing fixture owner runs with `--no-build --wasm` and explicit launcher/Node paths. It runs `html-handler-lifetime`, `html-handler-contracts`, `html-intrinsic-storage`, `html-rewriter`, and `html-rewriter-review`. Detailed stdout, stderr and exit status survive under `fixtures/<name>/`. Contract stderr names the case before it starts, including hangs. Its expected stdout is hand-written.

The upstream owner runs the full unchanged file with `--jobs 1 --timeout 15 --network loopback`. Its original per-test timeout is unchanged. Browser Node receives real `--expose-gc`. JSON retains passing, failing, skipped and todo case names plus completion/timeout/error status; raw per-file logs remain under `upstream-cases/`. No test filter, timeout increase, fake heap counter, or source edit is used. The helper returns nonzero for partial, skipped, todo, timed-out, missing, or failing upstream results even when the upstream census runner itself exits zero.

## Interpret results individually

These are real guest-parser contracts, not the source suite's fake parser. The tests use `bun:internal-for-testing.htmlRewriterCount`, held readers, WeakRefs, real GC and actual HTMLRewriter/Response operations. The error-site table covers exact object/falsy values without repeating the full host suite in every case. Streaming cancellation observes the real underlying source's single cancel callback. Buffered Response cancellation selects its materialized byte path before reading the body and observes the real reader's single cancel invocation. Its already-closed byte source has no live underlying cancel callback. Do not report that observation as a streaming-source callback.

For each upstream failure, retain its case, output, phase and reason. Report HTTP body buffering before handler entry, direct-stream support, and unavailable heap accounting separately when supported by that case's evidence. A 15-second file timeout without handler entry is not proof of a parser lifetime leak. A partially passing file is not green. The helper does not guess a limitation category from a timeout.

Run the same acceptance command separately for each qualified engine. No current source guest has been executed for this test-only follow-up. Historical guests are not current acceptance. Parent still owns test-delta review, integration/source freeze, one authorized build per needed engine, the final guest matrix, and normal final-head runtime/web-host/browser gates. Node/V8 with exposed GC does not establish Chromium or Safari behavior.
