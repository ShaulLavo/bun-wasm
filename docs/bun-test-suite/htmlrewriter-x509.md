# HTMLRewriter and X509Certificate

Measured on 2026-10-17 against Bun `cd95fa7a13b3f13be73e512b38ec111c1c228084`.
The baseline runtime is main `6e93c80c`. The implementation is `0f0fe09e`.

The [21-file selection](htmlrewriter-x509-files.txt) contains every file whose
baseline diagnostic mentioned the missing HTMLRewriter global or missing
X509Certificate export. Files run unchanged, one process per file, with one
worker, loopback-only networking, a 15-second file limit and a 2-second initial
per-test limit. Suite, runner, host sources, dependencies and deadlines match
before and after. Wasm hashes change; the embedded-engine launcher hash also
changes after its required rebuild.

## Results

| Engine | Fully passing files before → after | Observed tests passing before → after | File timeouts before → after | Unhandled errors before → after |
| --- | --- | --- | --- | --- |
| QuickJS | 0 → 9 | 51/230 → 145/367 | 1 → 2 | 10 → 2 |
| JSC | 0 → 10 | 51/230 → 136/359 | 1 → 2 | 10 → 2 |
| Browser | 0 → 10 | 52/230 → 143/375 | 1 → 1 | 10 → 2 |

Totals include observed passes, failures, skips and todos. Unblocking collection
registers more tests, including failing TLS tests. These are bounded observations,
not a claim that the full Bun suite passes.

All engines fully pass the X509 subclass file, DOCTYPE handler, HTML end-error
regression, regressions 07827, 21274, 21680 and 27025, additional HTMLRewriter
validation cases, and detached text-token regression. JSC and browser also fully
pass regression 19219. QuickJS preserves its engine's different missing-method
TypeError wording there.

`js/node/crypto/x509.test.ts` records 32 passes and one failure on each engine.
The remaining assertion needs nonempty `tls.rootCertificates`, which the TLS
adapter does not provide.

The extended two-file control is separate from the table. The full
`js/workerd/html-rewriter.test.js` still fails collection on unsupported
`ReadableStream({ type: "direct" })`. Node's parallel certificate script prints
`1..0 # Skipped: missing crypto`; it is a skip, with no certificate assertions
executed. Its replay uses `--node-parallel` so that skip is classified correctly.

## Remaining HTML lifetime cases

The lifecycle file now executes, with these bounded results:

| Engine | Pass | Fail | Skip | File timeout |
| --- | --- | --- | --- | --- |
| QuickJS | 29 | 12 | 1 | yes |
| JSC | 19 | 14 | 1 | yes |
| Browser | 24 | 25 | 1 | no |

Remaining cases include cancellation during a handler, abandonment of unreachable
never-settling handler promises, wrapper collection, and indexed Array prototype
accessors. Some also require unsupported direct streams, private module graph
APIs or native heap counters. Network-driven cancellation cases depend on the
existing HTTP streaming path. The other file timeout is the existing native
Web Stream consumer-state file. Passing heap-counter assertions does not prove
leak freedom, because per-type/protected counters remain unavailable.

The lifetime and intrinsic-storage parity gap was open when this was measured.

## Wasm sizes

These are optimized, uncompressed distribution files.

| Artifact | Before bytes | After bytes | Delta bytes | Delta |
| --- | --- | --- | --- | --- |
| `bun.wasm` | 14,950,972 | 15,244,020 | +293,048 | +1.96% |
| `bun-jsc.wasm` | 51,458,844 | 51,821,976 | +363,132 | +0.71% |
| `bun-browser.wasm` | 14,240,614 | 14,532,209 | +291,595 | +2.05% |

## Verification and reproduction

The initial pre-review build passes `scripts/test.sh` on QuickJS, JSC and browser, 201 fixtures
per engine, `scripts/test-web.sh` in full, and all six Chromium/WebKit engine runs
of `sandbox/tests/hmr-check.mjs`. The native launcher was rebuilt into the lane's
private target directory. Emitted HTMLRewriter and X509 TypeScript factories
were compared with current source on all three builds.

To repeat the selected census after building all artifacts and the launcher:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
source env.sh
mapfile -t files < docs/bun-test-suite/htmlrewriter-x509-files.txt
scripts/bun-suite.sh --engine quickjs --jobs 1 --timeout 15 --network loopback \
  --launcher "$CARGO_TARGET_DIR/release/bun-wasm" \
  --output /work/reports/bun-wasm-own-api-run/quickjs.json \
  --log-dir /work/reports/bun-wasm-own-api-run/quickjs-logs "${files[@]}"
```

Run through the heavy wrapper and repeat with fresh outputs for JSC and browser.
The focused fixtures are `html-rewriter` and `crypto-x509` under `scripts/test.sh`.

Raw before/after JSON, logs, provenance, gate commands, source checks and final
wasm artifacts are retained in
`/work/reports/bun-wasm-htmlrewriter-x509-2026-10-17/`. The final run is under
`verified/`; earlier failing probes remain separate. The coordinator owns removal
of retained evidence and artifacts after review and integration. Private build
targets, execution snapshots, preview server and worktree are removed by this lane.

## PR #41 review regressions

The review fixes merge main through PR #43, including PR #33's runtime changes.
`crypto-x509-options` covers all hostname options and a standalone self-signed
certificate. `html-rewriter-review` covers void-element end tags, error Responses
and both nullish selector values. The regression commit precedes the fixes.

The same certificate fixture passes on Bun 1.4.2 and Node 26.7.0. The HTML fixture
passes on Bun 1.4.2; Node has no HTMLRewriter API. Run the native references with:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
bun tests/fixtures/crypto-x509-options/index.ts
node tests/fixtures/crypto-x509-options/index.ts
bun tests/fixtures/html-rewriter-review/index.ts
```

Both new fixtures fail against each reviewed wasm artifact, 0 passing and 2
failing fixtures per engine. The X.509 diagnostic reports missing multi-label,
partial, subject and suffix-match behavior and the wrong standalone issuer.
The HTML diagnostic reports the missing void/selector exceptions and status-0
constructor failure. Bun's exact void-element error message is `No end tag.`.

The pinned BoringSSL defines four requested OpenSSL flags as zero compatibility
macros. Bun's own native code therefore uses a Rust matcher. This PR adapts its
OpenSSL matching path over the existing BoringSSL certificate accessors, without
changing BoringSSL or shared vendor source. The TypeScript response wrapper uses
the existing error-response factory and body storage, preserving document-end
handlers as Bun does.

Both new fixtures pass on all three rebuilt engines, including an additional
header-snapshot regression checked against Bun. The intermediate QuickJS artifact
fails that new header regression before the rebuild. Each full fixture gate
reports **202 passed, 2 failed**. `node-misc` expects the old subprocess errors,
and `pipe-closed-output` observes SIGPIPE exit 141. Both were open when this was measured.

The original fail-fast batch stopped at the first QuickJS gate. A continuation
builds all three engines and collects every remaining check. HMR passes all six
Chromium/WebKit engine runs. The first web gate hits EADDRINUSE at the subprocess
browser helper's fixed default port 4183; its recheck uses
`BUN_WASM_TEST_PORT=0`. The recheck gets past subprocess startup but fails
`webkit browser atomic-transfer` with `TypeError: Importing a module script
failed.` at `web/tests/browser-workers.ts:27`. The full web gate therefore also
remains red. No fixture expectation is changed to hide a failure.

The same 21-file selection has identical counts before and after these review
fixes. The comparison includes the main merge and is not an isolated measurement
of the API changes.

| Engine | Fully passing files | Observed passes | File timeouts |
| --- | --- | --- | --- |
| QuickJS | 9 → 9 | 145 → 145 | 2 → 2 |
| JSC | 10 → 10 | 136 → 136 | 2 → 2 |
| Browser | 10 → 10 | 143 → 143 | 1 → 1 |

The optimized artifact sizes below compare the reviewed artifacts with the
rebuilt branch, including the main merge.

| Artifact | Reviewed bytes | Rebuilt bytes | Delta bytes |
| --- | --- | --- | --- |
| `bun.wasm` | 15,244,020 | 15,259,713 | +15,693 |
| `bun-jsc.wasm` | 51,821,976 | 51,839,966 | +17,990 |
| `bun-browser.wasm` | 14,532,209 | 14,542,507 | +10,298 |

Raw native references, all-engine failing runs, per-gate logs, commands and
rebuilt artifacts are retained in
`/work/reports/bun-wasm-htmlrewriter-x509-review-2026-10-17/`.

## Second review: fulfilled handlers and failed end tags

Current main through `ab027f91` is merged for this review. The targeted run adds
an already-fulfilled native Promise whose value has a stateful `then` getter.
Completion now discards that value, so successful handlers do not read its
accessor twice. A streamed void-element regression catches `No end tag.`, forces
collection while the output remains open, and verifies its callback is released
before cancellation. Failed registrations roll back their JavaScript map entry;
native token user data changes only after end-tag handlers validate.

The exact retained `0fbec4d` artifacts fail both new groups on QuickJS, JSC and
browser. All three rebuilt engines pass `html-rewriter`, `html-rewriter-review`,
`crypto-x509` and `crypto-x509-options`, **4 passed, 0 failed** per engine. The
first fixture includes undefined, null, false, zero, empty-string and Error
rejection identities. Native Bun 1.4.2 passes all six groups in the expanded
HTML review fixture. Runtime typechecks and their 35 tests pass.

Builds and focused runs use the heavy queue. One build attempt found a Rust
borrow conflict in the native ordering change; after correction, all three
builds and the targeted gates pass. Full suites are not repeated in this round;
the earlier full-gate observations above describe their earlier source heads.

Commands, reviewed-artifact hashes, red/green logs and fresh wasm files are in
`/work/reports/bun-wasm-htmlrewriter-x509-review-2026-10-17/second/`.
The coordinator owns these review artifacts until integration. `red-*.log` is
the authoritative second-review reproduction; exploratory runs against older
artifacts are separate under `superseded/`.
