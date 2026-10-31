# Bun builtins: measurement history

Working notes moved out of `docs/bun-builtins.md`: per-change size and startup tables, review-fix comparisons and verification logs. Paths under `/work/` and commit hashes record where the work happened.

## Intrinsic-global review fix

The intrinsic table now holds original constructor values captured during bootstrap, before application code runs. Replacing a public String or Buffer before the first import or after it does not replace the corresponding intrinsic. Adapter primitives such as Object, Function, Map, Set, Reflect, Proxy, Symbol, and error constructors are captured too. The browser engine separately captures its original String for evaluator, import, and fetch coercions.

Capturing the original Buffer realizes the existing runtime Buffer module during bootstrap. The generated Bun factories still compile only on first require. Loader regressions check zero factory compilations at adapter initialization, one on first require, and no additional compilation on a cache hit.

The following measurements compare the reviewed mechanism artifact with the fixed mechanism. Each median discards the first of seven samples. The shared-host timing differences do not establish a speed improvement. Raw samples and artifact hashes are in `/work/reports/bun-wasm-builtins-review/mechanism-size-startup.json`.

| Engine | Wasm bytes before → after | Gzip-9 bytes before → after | Empty startup median ms before → after |
| --- | --- | --- | --- |
| quickjs | 10,903,625 → 10,904,811 | 3,830,428 → 3,831,040 | 58.85 → 60.46 |
| jsc | 46,269,095 → 46,270,347 | 12,871,492 → 12,872,506 | 176.14 → 173.74 |
| browser | 10,179,703 → 10,180,804 | 3,532,793 → 3,533,582 | 76.54 → 74.08 |

## Loader mechanism measurements (initial artifacts)

The loader-only artifact passes 89 of 89 runtime fixtures on each engine. The generated FreeList and loader checks pass on all three engines. Web verification passes its 16 unit tests, local networking and registry checks, Chromium and WebKit checks, and all six HMR engine/browser combinations. Public modules are unchanged in this PR.

Before artifacts are rebuilt from main at 78e0ff8. After artifacts add this loader mechanism. Both use the same private Bun worktree with the repository's existing patch 0009 applied. The shared vendor was missing that patch at lane start. No new upstream patch was created. The private vendor uses the shared generated build options read-only.

Startup is wall time for an empty `-e 0` process. Seven sequential runs use wasmtime for QuickJS and JSC, and Node's host engine for browser. The first run is discarded. The table reports the median of the remaining six on this shared host. Small timing differences do not establish a speed improvement.

| Engine | Wasm bytes before | Wasm bytes after | Gzip-9 bytes before | Gzip-9 bytes after | Startup median ms before | Startup median ms after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| quickjs | 10,867,217 | 10,903,625 | 3,818,700 | 3,830,428 | 58.38 | 59.28 |
| jsc | 46,231,974 | 46,269,095 | 12,858,478 | 12,871,492 | 171.52 | 170.51 |
| browser | 10,145,021 | 10,179,703 | 3,523,665 | 3,532,793 | 72.41 | 73.34 |

Raw samples, artifact hashes, upstream results, command logs, and cleanup evidence are retained in `/work/reports/bun-wasm-builtins/` for coordinator review.

## First public module batch (initial measurements)

The first batch replaces the local querystring implementation and incomplete punycode stub with Bun's generated modules. Both load lazily and require no native JS2Native hooks. Querystring reuses the runtime's Buffer implementation and the adapter's URIError constructor. Punycode uses portable string operations and RangeError.

The two public fixtures pass after an explicit garbage collection and verify CJS/ESM export identity. The complete runtime fixture suite passes 91/91 on each engine. Generated loader checks, web checks, the site build, and all six browser/engine HMR combinations pass.

### Module coverage

The upstream Node assertion files are omitted by the standard bun:test filename census. `scripts/bun-builtins-node.py` runs them unchanged. The focused comparison uses `--isolated-common`, replacing only their unused common import with an empty module. These results measure module assertions, not the complete upstream harness.

| Module | QuickJS before → after | JSC before → after | Browser before → after |
| --- | --- | --- | --- |
| querystring | 1/4 → 4/4 | 1/4 → 4/4 | 1/4 → 4/4 |
| punycode | 0/1 → 1/1 | 0/1 → 1/1 | 0/1 → 1/1 |

The unchanged common harness remains 0/5 on all engines, before and after, because node:net lacks getDefaultAutoSelectFamilyAttemptTimeout. Its failure is retained separately. No raw Node script is counted as a standard bun:test census pass.

The standard 30-file slice covers related URL behavior, events, util/parse_args, and assert. Counts below compare the rebuilt current main with the completed batch. Existing failures remain; there are no per-file pass-count regressions.

| Engine | Fully passing files before → after | Assertions passing | Failing | Errors | Timeouts |
| --- | --- | --- | --- | --- | --- |
| quickjs | 10/30 → 10/30 | 798 → 798 | 140 → 140 | 1 → 1 | 1 → 1 |
| jsc | 10/30 → 10/30 | 754 → 754 | 141 → 141 | 2 → 2 | 1 → 1 |
| browser | 10/30 → 10/30 | 800 → 800 | 141 → 141 | 1 → 1 | 0 → 0 |

Reproduce through the heavy wrapper with these commands for each engine:

```sh
python3 scripts/bun-builtins-node.py --engine <engine> --isolated-common --output <fresh-focused.json>
python3 scripts/bun-builtins-node.py --engine <engine> --output <fresh-full-harness.json>
scripts/bun-suite.sh --engine <engine> --network loopback --jobs 1 --launcher "$CARGO_TARGET_DIR/release/bun-wasm" --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" --output <fresh-suite.json> js/node/url js/node/events js/node/util/parse_args js/node/assert
```

### Size and startup

These are sequential before/after measurements. Each median discards the first of seven startup samples. The timing differences include shared-host noise; this change makes no speedup claim. Factories parse only when required.

Historical querystring-only switch on the earlier main.

| Engine | Wasm bytes before → after | Gzip-9 bytes before → after | Empty startup median ms before → after |
| --- | --- | --- | --- |
| quickjs | 10,895,736 → 10,913,839 | 3,826,482 → 3,828,777 | 57.57 → 59.55 |
| jsc | 46,258,047 → 46,276,151 | 12,864,806 → 12,868,924 | 170.88 → 172.29 |
| browser | 10,173,649 → 10,191,874 | 3,530,946 → 3,532,886 | 71.70 → 71.17 |

Complete batch versus mechanism.

| Engine | Wasm bytes before → after | Gzip-9 bytes before → after | Empty startup median ms before → after |
| --- | --- | --- | --- |
| quickjs | 10,903,625 → 10,927,547 | 3,830,428 → 3,833,450 | 56.46 → 58.62 |
| jsc | 46,269,095 → 46,293,057 | 12,871,492 → 12,873,385 | 170.57 → 169.42 |
| browser | 10,179,703 → 10,203,739 | 3,532,793 → 3,536,518 | 71.40 → 74.23 |

Complete batch versus current main.

| Engine | Wasm bytes before → after | Gzip-9 bytes before → after | Empty startup median ms before → after |
| --- | --- | --- | --- |
| quickjs | 10,867,217 → 10,927,547 | 3,818,700 → 3,833,450 | 58.67 → 62.05 |
| jsc | 46,231,974 → 46,293,057 | 12,858,478 → 12,873,385 | 177.18 → 172.64 |
| browser | 10,145,021 → 10,203,739 | 3,523,665 → 3,536,518 | 72.00 → 70.62 |

First-import process startup includes the module require. Querystring compares its earlier isolated switch; punycode compares the current mechanism with the completed batch.

| Module | Engine | Startup median ms before → after |
| --- | --- | --- |
| querystring | quickjs | 56.86 → 59.76 |
| querystring | jsc | 170.30 → 174.09 |
| querystring | browser | 69.24 → 71.57 |
| punycode | quickjs | 63.28 → 58.11 |
| punycode | jsc | 170.77 → 177.18 |
| punycode | browser | 70.75 → 74.40 |

## Public module verification after intrinsic capture

Four failing-first fixtures cover String and Buffer overrides in separate processes, both before the first import and afterward. The String cases also decode punycode. All four failed on each engine's reviewed artifact and pass on the fixed artifacts. The complete module fixture suite now passes 95/95 on QuickJS, JSC, and the browser engine. Both branches pass the generator and loader checks, web verification, site build, and all six HMR combinations.

The reviewer's exact querystring script prints Error with each reviewed module artifact and {"a":"1"} with each fixed artifact. The five focused upstream assertion scripts still pass on all engines. The documented common-harness limitation is unchanged.

These measurements compare the reviewed module artifacts with the fixed artifacts. They include bootstrap's earlier Buffer initialization. Generated Bun factories still compile lazily. Each startup median discards the first of seven samples; shared-host differences do not establish a speed improvement.

| Engine | Wasm bytes before → after | Gzip-9 bytes before → after | Empty startup median ms before → after |
| --- | --- | --- | --- |
| quickjs | 10,927,547 → 10,928,781 | 3,833,450 → 3,834,055 | 61.02 → 59.98 |
| jsc | 46,293,057 → 46,294,456 | 12,873,385 → 12,874,114 | 179.05 → 171.05 |
| browser | 10,203,739 → 10,204,866 | 3,536,518 → 3,537,175 | 71.78 → 72.99 |

Raw logs, samples, and hashes are in `/work/reports/bun-wasm-builtins-review/`. Updated artifacts are in `/work/artifacts/bun-wasm-builtins-review/{mechanism,modules}/dist/`.
