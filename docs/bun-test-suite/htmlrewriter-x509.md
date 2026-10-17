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

The [compatibility follow-up](../../plans/compatibility-followups.md#htmlrewriter-lifetime-and-intrinsic-storage-parity)
records the next reproduction and relevant implementation points.

## Wasm sizes

These are optimized, uncompressed distribution files.

| Artifact | Before bytes | After bytes | Delta bytes | Delta |
| --- | --- | --- | --- | --- |
| `bun.wasm` | 14,950,972 | 15,244,020 | +293,048 | +1.96% |
| `bun-jsc.wasm` | 51,458,844 | 51,821,976 | +363,132 | +0.71% |
| `bun-browser.wasm` | 14,240,614 | 14,532,209 | +291,595 | +2.05% |

## Verification and reproduction

The final build passes `scripts/test.sh` on QuickJS, JSC and browser, 201 fixtures
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
