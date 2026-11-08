# SpiderMonkey measurement setup

Status: Approved source setup only. This change authorizes no producer generation, admission, timing campaign, app census, build, release, or deployment. G3 and G4 runtime prerequisites remain blocked. The public107 production hold remains unchanged.

## Membership and candidate schedules

The owner removed Hermes from this campaign. The native labels are `quickjs`, `jsc`, `spidermonkey-interp`, and `spidermonkey-pbl`. Chromium adds `browser`. Browser is unavailable natively and is recorded separately from the four-arm native denominator.

`williamsSchedule` constructs the first row by alternating the lowest remaining index with the highest. Each subsequent row shifts every index modulo the arm count. Odd counts also require the reversed rows.

- Four native arms require four rows per balanced block. Eight candidate rounds repeat that block twice, so every arm has eight observations per workload. Each arm occupies each position twice, and each directed adjacent pair occurs twice.
- Five Chromium arms require ten rows per balanced block. Each arm occupies each position twice, and each directed adjacent pair occurs twice.

These are source defaults for a future registry, not measured results. The old ten-round native and six-round Chromium schedules are invalid for this membership. One app-census round is an explicit census, not a balanced timing experiment. Fewer than six timing observations and high relative MAD remain flagged, never dropped.

## Registry and receipt contract

`engine-arm-registry.ts` parses schema version 2. It keeps the plan's descriptor identity fields and adds complete `program` and `servedGzip` values using the authoritative `ProgramFiles` parser. The registry also requires the admitted launcher identity and a Browser receipt. Measurement labels do not register production engine kinds.

Every file identity contains an absolute path, a positive byte count, and a SHA-256 digest. Every arm has the same source commit and tree. All arms, including Browser, share one exact admission manifest and receipt. The manifest path must be the canonical `manifest.json` read by the owning producer verifier. A separate Browser generation stays blocked until its own authoritative verification contract exists. The two SpiderMonkey labels share identical core, side, and gzip identities, including paths. Their tier environments and cache identities differ.

Browser uses the production `single` program representation, the measurement kind `browser`, and the existing `browser-single` receipt profile. Its receipt includes `buildReceipt`, the identity of the original guest build receipt. The verifier checks that receipt with `verifyGuestBuildReceipt`, checks its source, and verifies the raw and gzip bytes.

The additional admission receipt is an integration contract, not existing producer output. Its fields are `kind: "engine-measurement-admission"`, `evidence`, `admitted: true`, `sourceCommit`, `sourceTree`, `manifestSha256`, and `files`. `files` contains complete absolute file identities for the admitted raw files, gzip files, launcher, and Browser build receipt. Each identity must also occur in the referenced reusable producer manifest, whose paths remain relative to that manifest.

`loadArmRegistry` calls `verifyMeasurementInput`. That function rejects synthetic evidence, verifies files, gzip roundtrips, and actual Wasm engine profiles, verifies the Browser build receipt, and invokes the owning `engine-producer.ts verify split` command. The exact canonical manifest is hashed again after the owning verifier returns. JSON flags alone cannot authorize a measurement. The producer must emit and support this contract before an actual campaign can start. This setup neither emits nor fabricates that output.

Registry tests use explicitly synthetic receipts and text fixtures, not executable Wasm artifacts. The separate tiny browser-driver check is described below. The test-only `verifyArmRegistry(..., { synthetic: true })` option checks file identity logic. It does not provide a production CLI bypass.

## Connected consumers

The native runner requires `--registry` for Wasm measurement. The registry owns arm selection and launcher identity. The runner verifies the actual core and side selected by the launcher, passes tier settings in both the child process environment and guest `--env` arguments, and warms separate label-owned caches. Cold samples disable the Wasmtime cache. Failures remain observations, missing cells remain null summaries, and a failed campaign returns nonzero.

The census registrar and CLI reducer consume the registry. The reducer retains all registered arms and stages, rejects duplicate or unexpected cells, and checks source, program, tier, manifest, admission, and fixture provenance. Blocked, missing, and network-guard observations stay in the denominator. The size reducer keeps `core`, `gzip`, `side`, `sideGzip`, `rawBytes`, and `gzipBytes` for existing table readers. Unknown memory counters and the unmeasured common-core delta remain null.

`app-matrix/engine-arms.ts` supplies typed child requests and `runChromiumSchedule`. That scheduler creates a fresh driver context per arm and round, closes the context before the next arm, and retains blocked and failed workload cells. Cleanup is bounded to five seconds by default. A rejected or timed-out close stops before another context opens and throws `ChromiumScheduleError` with all collected outcomes, the cleanup error, and blocked records for every unattempted cell. This records unconfirmed cleanup, not physical or functional quiescence. Synthetic driver tests cover normal contexts, rejected close and a never-resolving close, with all fifty context attempts represented in the result or partial error. They do not launch Chromium or constitute browser acceptance.

## Compile-phase attribution

The native runner requests a host-only `BUN_WASM_COMPILE_PHASE_PATH` outside the guest mount and sends its bound `BUN_WASM_COMPILE_PHASE_REQUEST`. An emitter that reports a number must return that request identity with the direct core and side compiler spans described below. Cache deserialization and bootstrap are not compiler spans.

The current launcher validates the host request and explicitly writes null. The direct primary calls are in `linked::Programs::load`, outside the released measurement write set, so native compiler coverage is not claimed. Guest stderr cannot supply this evidence, and cold wall time minus precompiled wall time is never treated as compile time. The Chromium driver likewise needs a direct host compile-phase measurement. Page-to-ready wall time is not an alternative.

## Remaining owner hooks

- Production kinds stay authoritative in `src/engine-kind.ts`. The exact no-Hermes interface checkpoint `9b1a24dd3caf359c61bc51f988cc8f6fa4d5ba04` registers only QuickJS and JSC. Its parser correctly rejects SpiderMonkey. The later reviewed G3 integration must register SpiderMonkey before this planned registry can admit it. No cast or duplicate kind table bypasses that gate.
- The producer owner must support the no-Hermes generation and admission extension above. The frozen producer does not yet satisfy this contract.
- The package and browser owner must pass the selected guest tier before the first worker starts. `censusChild` supplies the exact engine kind, label, tier, environment, program identities, and cache identity.
- Both the Chromium timing driver and the app-matrix census selectors consume typed requests. `scripts/app-matrix.sh --product --census-plan=PLAN --arm=LABEL` selects one admitted arm. The plan owns its host, launcher, catalog and tier. No measurement label becomes an engine kind.
- Native direct compiler hooks still need a release of the exact calls in `crates/bunwasm-host/src/linked.rs`. Browser paired linking also lacks complete direct compiler hooks. Neither path reports a partial time.

Independent review and CI are still required before integration into PR 455. This source setup is not runtime qualification.

## Runnable measurement hooks added on restart

The supported-source reference is `a7a3ee81a0ade4a6d9528f4aa3d9bdd0919a45bf`, whole tree `f1199bbe1a3478f0473e0a3b432921621b0cc117`. It is not an SM packet. The completed setup and reconciliation at `94d227f72192863ff2573fb4c79aae6b8d9aab9d`, tree `0738ffe4d330f696c2e7a88a1359fe2ca79b5933`, are reused without repeating the earlier four-file checkpoint.

`bench-engines.ts --host chromium --registry REGISTRY --url URL --output NEW.json` now connects the schedule to `engine-playground-driver.ts`. The adapter calls the existing `web/tests/playground.mjs` `ready`, `run`, and `writeFile` controls. It never copies the playground or registers another engine kind. Each arm and round gets a fresh context. The query selects `child.engine`, not the measurement label. The label identifies the cache/context. Every guest command receives its own validated tier assignment before the command starts a Bun worker. No controller environment changes.

The adapter verifies the actual page build fingerprints and the actual served raw or gzip response bodies against the registry. It never replaces served bytes to make a stale page pass. Fixed fixtures are written once per context. Reports retain fixture hashes, command requests, driver source hashes, all registered summaries, and partial samples. Engine-ready wall time and command wall time are separate observations. Browser workload names inherited from the native fixture catalog do not imply native Wasmtime cold or precompiled cache behavior.

`ChromiumScheduleError` now also stops on unconfirmed cleanup during `driver.open`. Checkpoints save each collected cell before context cleanup. A launch failure, failed workload, or failed cleanup cannot silently remove another arm from the denominator. Native warm-cache preparation failure likewise blocks only that arm's precompiled cells. Cold cells and other arms still run. Blocked cells have null wall and RSS values, rather than fabricated zeros. Native summaries retain expected, blocked, and not-run counts.

`engine-compile-observation.ts` defines the disjoint instrumentation interface. `compileRequest` binds the source, complete `ProgramFiles`, measurement label, host, and unique invocation. A host observation copies those fields and supplies `spans`, exactly one `{ part, startMs, endMs }` entry for each core or side module. Times use the host monotonic clock. The metric is the sum of direct compiler span durations, not elapsed wall time across overlapping spans. Download, cache deserialization, and bootstrap do not count. Missing instrumentation returns null. A cache-only invocation must not invent compiler spans.

The native adapter supplies `BUN_WASM_COMPILE_PHASE_REQUEST` and the existing host-only `BUN_WASM_COMPILE_PHASE_PATH`. The file remains outside the guest mount. The Chromium adapter accepts an optional `HostCompileObserver` with `begin(page, request)` and `end(page, request)`. The CLI installs the optional observer. An init script carries the startup request into the new document before its loader starts. Guest stderr, performance marks that include streaming/download time, and page-ready wall time cannot fill that gap.

The authoritative interface references are `272bb7d2f92b23a5ae15eb541e3a13f3fe51e6fe`, tree `9d498d3521fc34dbca679a02bab5cff90889ca7a`, and its update `5fe2443502cf9ea05cfd4426445a1b2dededbe20`, tree `d2cfd8412f75d69e33b71ca3b13069e4f8535c66`. Explicit measurement parsing consumes their broad `Engine` and `ProgramFiles` definitions. Normal `pairedEngines` publication stays QJS and JSC. Neither intermediate host commit is integrated here. A read-only virtual module supplies the relayed file during reference checks without editing host-owned source.

The real-browser check uses Chromium and the existing playground controls against an eight-byte synthetic file and a tiny synthetic terminal page. It checks command success, command failure, gzip readback refusal, and context/process cleanup. It is not Bun runtime or SM acceptance. No actual benchmark fixture bundle, producer generation, app campaign, or timing table was generated.

The product app census accepts typed requests and retains complete program, gzip, admission, source and page identities. It refuses a changed catalog, duplicate typed requests, a different core/side/launcher and stale page bytes. The shell receives the selected tier before worker creation. The normal menu and producer defaults are unchanged. No app census has run against admitted engine artifacts.

## Completion of the transferred checkpoint

The transfer started at commit `37a3497a7f309e2098edc6550c91c3cddebd59ca`, tree `4af51727d371763ad9612b9d6464e9ba2972fed9`. All twelve file identities in the transfer manifest were checked and preserved in a separate local commit before refinement. The native module, browser observer, census helper and focused regression file were all retained.

The incomplete native checkpoint timed an arbitrary closure and tested it with sleep. That is not compiler evidence. The final module instead validates the host-only request, writes null and removes both observer environment fields from the guest environment, including explicit and inherited assignments. No native positive compiler control has run, and no native compiler coverage is claimed. Instrumenting `linked::Programs::load` and proving it with a tiny matching Wasmtime control remain integration work, not permission to rebuild the launcher here.

The browser loader records a direct `WebAssembly.compile` call only for a cached single module. Fresh streaming compilation stays null because the API completion includes download and decompression waits. Paired preparation stays null because `engineLinkPlan` performs preliminary compiles before Waffle prepares the actual link plan. Wrapping the first two global compile calls would undercount the program and temporarily mutate a shared browser API, so that partial approach was removed. The preserved transfer commit retains it for review.

A tiny Chromium control uses the actual `loadWasm` cached-single path and the actual page observer, with the request installed before navigation. It asserts a non-null direct compiler duration. A second invocation exercises actual streaming load and asserts null. These controls compile an eight-byte synthetic module, never instantiate a Bun guest and do not qualify any engine packet. Unit controls also reject failed, incomplete and unsupported paired observations. No download time is subtracted from wall time.

Actual native four-arm and Chromium five-arm campaigns remain blocked on an admitted same-source side/core/launcher cohort, Browser bytes and receipt, complete compiler observers and G3 acceptance. No byte admission, benchmark table or default decision is claimed.

The bounded source checks pass for scripts and the changed browser files. The complete web type gate is blocked by the pre-existing `web/scripts/node-host.ts:16` import of `./node-install-net.mjs`; the tracked implementation is `node-install-net.ts`. With frozen root, web and sandbox dependencies, `tsc -p web/tsconfig.quality.json` reports only TS2307 for that import. The same import exists at the original `37a3497a` checkpoint. This fenced host source was not changed by measurement work.
