# Canonical engine closures

Normal publication supports Browser, QuickJS, and JavaScriptCore. Hermes is
withdrawn, not a passing or optional publication gate. SpiderMonkey is not yet a
published engine. Retained Hermes source and old receipts do not permit shipping
its guest, side, loader registration, native library, or embedding evidence.

## Paired-core producer

The split producer builds one generic core and composes it with the QuickJS and
JSC sides. It never rebuilds native VM libraries implicitly. Production needs a
fresh exact tested-source authorization, a clean exclusive checkout, and a new
output root. An old authorization or held packet cannot authorize another unit.

```sh
source env.sh
export BUN_WASM_ENGINE_ROOT=/absolute/owned/new-output
export JSC_BUILD_DIR=/absolute/admitted/jsc
bun scripts/engine-producer.ts build split
bun scripts/engine-producer.ts verify split
```

`src/engine-kind.ts` owns `pairedEngines`, `PairedEngine`, and
`Engine = PairedEngine | "browser"`. The split input scopes are `core`, `quickjs`,
and `jsc`. The core uses `engine-split,bun-transpiler,bun-build`. Each side retains
its original component receipt. Each composition has its own build receipt.
Unknown and withdrawn engine tags, build names, descriptors, and receipt scopes
are rejected, without a compatibility fallback.

Both paired engines run the native-launcher and Node-host smoke before web
staging and the complete maintained actual matching-version guest hook-smoke.
The staged web asset registry requires both pairs, Browser, and tools. Missing
assets or receipts prevent a reusable manifest. Old Hermes outputs, receipts,
and asset registry entries are rejected even beside otherwise valid engines.
Normal native Clippy and tests exclude the two dormant Hermes crates. Generic
formatting and source-integrity scans still cover retained source.

The producer builds one launcher with the pinned Cargo host recipe and records
its source, command, and binary identity. `BUN_WASM_LAUNCHER` can select an
existing launcher only with its original `BUN_WASM_LAUNCHER_RECEIPT`, matching
the current source and executable bytes. No stale launcher is relabeled.

## Complete normal publication

A reusable paired-core manifest is not a complete delivery or application
acceptance. The outer publication also retains these independently receipted
builds, identified by `publicationGuestPaths` in `scripts/producer-closure.ts`:

- `browser/default/bun-browser.wasm`, the default Browser build.
- `browser/source-cache/bun-browser.wasm`, the distinct required source-cache profile.
- `tools/bun-tools.wasm`, the tools guest.

The source-cache profile does not replace default Browser. Both Browser profiles
keep their original input enumeration, optimizer choices, and build receipts.
The split producer's `producerArtifactPaths` still requires the common core,
both original engine sides, both compositions, launcher, shell guests, web
assets, hook evidence, and the JSC embedding receipt.

The outer delivery uses `completePublicationArtifactPaths` and
`requireCompletePublicationFiles`. It preserves source, original or canonical
reuse provenance, current host and reader code, native JSC admission, and before,
after, and pre-seal input, vendor, and native custody. Missing one of these files
is a failure, not a reduced publication profile. `verifyPublicationBuilds`
accepts exactly the six supported raw guest names and their fingerprints.
`verifyPublicationNativeBacking` accepts only JSC and the shared sysroot. Original
Bash sidecars, runtime and program release inputs, vendor evidence, and the native
JSC header manifest remain required delivery files.
Decompressed served files must match the admitted raw bytes.

Every remaining gate stays blocking:

- Complete maintained matching-version guest hook-smoke, including live, peak,
  heap, backing-store, refresh, failure, exact-actor, child, and terminal assertions.
- Complete corrected Browser, QuickJS, and JSC publication matrix in Chromium,
  Firefox, and WebKit. Candidate admission, actual shared-wait arming, causal wake,
  start, unwind, awaited return, and functional quiescence remain required.
- JSC embedding and allocation checks, original native input, stamp, header,
  library, and dependency validation, and final custody after consumers stop.

The authoritative memory maximum remains 1,073,741,824 bytes. Hook fixtures retain
an 8,388,608-byte allocation and a 1,140,850,688-byte failure request. Synthetic
source fixtures are not accepted workload bytes or a production gate verdict.

The consumer tuple remains runtime 0.0.107, programs 0.0.15, program manifest
schema 2, and host interface 1. Bash uses original artifact 13057504313, attempt 1,
from source `32b9103c762954bbe6e728fb86dc6cafa532edea`, after canonical intake.
There is no duplicate Bash build or byte admission implied by source qualification.

Failed or held roots and their releases, artifacts, receipts, and retention
records remain immutable and non-admitted. Do not trim or reseal them into this
scope. Independent source review and selected-source CI precede a fresh exact
tested-source release for the sole existing producer. A new source contract alone
neither resumes that producer nor authorizes sealing, merge, or deployment.

## Shared-group QuickJS remains unavailable

This branch retains shared-group types and receipt contracts, but lacks the
native implementation and `tests/shared-group/worker-alias.ts`. Requests fail
before input inventory or recipes when that proof fixture is absent. No placeholder
proof can bypass this rejection.

Shared-group admits only QuickJS, with the imported shared-memory profile,
build-std inputs, original core and side receipts, no stock C++ runtime member,
and the complete worker proof. It does not qualify JSC, Browser shared workers,
a memory-limit change, or an application. Split and shared-group outputs never
verify against each other. No capacity policy changes with this scope withdrawal.

## Read-only verification and measurements

Verification refuses an active producer and checks the remaining component,
composition, input, asset registry, and launcher identities. Building an already
manifested root performs verification without rewriting it. Failed production
retains diagnostic state and releases its owned lock.

Measurements use the manifest's exact launcher and source identity. Source `dist`
and `web/dist` staging resolve to the canonical output only after production
consumers stop. Never stage through an old frozen checkout. Full application
acceptance and independent final byte intake remain separate decisions.
