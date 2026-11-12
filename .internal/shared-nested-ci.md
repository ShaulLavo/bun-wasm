# Shared-group native check delivery

Status: Approved, J11 milestone 1. This gate adds no engine or browser rollout.

The existing Rust job builds the native launcher once. It publishes that executable
and its source revision as a short-lived workflow artifact. The existing shared
sysroot job consumes this launcher after the Rust job succeeds. It remains the
single producer and proof owner for the shared-pic sysroot.

That shared job builds the ordinary transpiler-enabled shared-group core and
QuickJS and JSC shared-group sides with the existing producers. Each distinct
profile keeps its own cache and output directory. It validates and composes the pair, then runs
native checks selected by feature-owned `profile: shared-group` metadata.
No workflow command names a semantic fixture directly.

Ordinary native metadata omits the profile and continues to mean split. Its
selection, fixture commands and producer stay unchanged. Closed-schema tests cover
profile selection, bad profile values and unrelated owners. A shared consumer
requires the real matching group pair and launcher. Missing files, unsupported
capability, a failed assertion or a mismatched workflow source fails the job.
Nothing turns those outcomes into a passing skip.

The producer-to-consumer chain is:

`Rust job -> native launcher artifact -> shared PIC job -> one group core/side -> shared native fixture checks`.

Existing libc proofs, Rust tests, unshared fixtures and independent source review
remain blocking. C67 measurements retain their original labels. Runtime fixes,
not report freshness, justify subsequent builds.

## Download the original shared programs

The normal `Shared PIC sysroot proof` job retains one complete program per engine
for one day. It adds no producer or test job.

| Artifact | Existing producer output | Original members |
| --- | --- | --- |
| `shared-quickjs-program` | `$CARGO_TARGET_DIR/shared-native/program/` | `bun.wasm`, `quickjs.wasm`, `quickjs.wasm.engine.json`, `bun-core.wasm.core.json`, `source.txt` |
| `shared-jsc-program` | `$CARGO_TARGET_DIR/shared-native/program-jsc/` | `bun.wasm`, `jsc-engine.wasm`, `jsc-engine.wasm.engine.json`, `bun-core.wasm.core.json`, `source.txt` |

Both producers explicitly request `shared-group`. The directory upload preserves
filenames and original file bytes, including receipts and their source snapshots.
`bun.wasm` is the tagged core in both directories, including JSC. Its original
`bun-core.wasm.core.json` receipt describes the untagged common core, not the
post-tagged bytes. The engine receipt describes the matching side. Do not rename
members, regenerate receipts, or substitute a different source revision.

QuickJS uploads immediately after its successful producer, before native and
Chromium checks. JSC keeps PR 582's `shared-jsc-producer` and `shared-jsc-program`
identities and uploads after its checks. Both use `always()` with the corresponding
producer's successful outcome, so downstream failure does not suppress retention.
A failed or skipped producer uploads nothing. Missing upload output is fatal.
Selection, native and Chromium checks, and their deadlines remain unchanged.

Download the chosen artifact from its workflow run into a fresh consumer-owned
directory. Native qualification also needs that run's separate
`native-profile-launcher` artifact, with its original `bun-wasm` and `source.txt`.
Check both source files against the run's actual checkout revision. Pull-request
runs may name the merge revision rather than the branch head. Run the existing
receipt and pair checks on the retained bytes. Do not rewrite metadata to match
a newer checkout. Set `BUN_WASM_PROFILE_PROGRAM` to the downloaded `bun.wasm` and
`BUN_WASM_LAUNCHER` to the separate launcher's `bun-wasm`, restoring its executable
bit as the workflow already does.

These artifacts are qualification inputs, not qualification results. A draft PR
or an unselected job produces no group artifact. An earlier failing consumer can
prevent the later JSC producer from starting. Retention cannot provide a program
that was never produced, and it expires after one day. Missing inputs do not
justify a duplicate local build. Oxc parsing, JSC Firefox and Nuxt acceptance
still require actual consumer execution.

`scripts/ci-shared-program-handoff.test.ts` covers the producer-to-directory
mapping, full-directory uploads, fatal missing output, failure retention and
unchanged consumers. Its feature manifest belongs to the existing quality gate.
