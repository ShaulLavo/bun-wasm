# Data parsers and glob

The `parsers-glob` branch exposes Bun's glob matcher and walker, data parsers,
and serialization APIs on all three engines. No vendored Bun source or tests
change. The upstream revision is `4ceda2c2868d3a7703c7737ddd9de7244ec384df`.

## Implementation

- `Bun.Glob.match`, `scan`, and `scanSync` call `bun_glob`. Scans pass `cwd`,
  `dot`, `absolute`, `followSymlinks`, `throwErrorOnBrokenSymlink`, and
  `onlyFiles` to Bun's own walker. Options ignore inherited properties.
- `fs.glob`, `fs.globSync`, and `fs.promises.glob` share that walker. They
  accept pattern arrays, exclusion patterns or callbacks, `cwd`,
  `followSymlinks`, and `withFileTypes`. Promise validation happens when the
  async iterator advances. Exclusions filter matching paths and descendants
  after traversal, so they do not avoid the cost or errors of reading an
  excluded directory.
- `bunwasm-transpiler/src/data.rs` calls `bun_parsers` for TOML, YAML, JSON5,
  JSONC, and the complete JSON values found by JSONL. Parser log messages
  supply syntax errors. Stack limits become `RangeError`.
- The parser result crosses the engine boundary as a graph. This preserves
  YAML aliases and cycles, own `__proto__` properties, negative zero,
  nonfinite numbers, and escaped lone UTF-16 surrogates. User string inputs
  to TOML, YAML, and JSON5 use USVString conversion. Byte inputs remain bytes.
- TOML, YAML, and JSON5 imports use Bun's normal data loaders. JSONC imports
  use the public parser, with empty imported documents yielding `{}`.
- JS serialization follows the pinned Bun runtime implementations. TOML,
  YAML, and JSON5 expose `stringify`. JSONC exposes `parse`. JSONL exposes
  `parse` and `parseChunk`, including partial results, byte or character
  offsets, completion state, and errors.
- TOML dates use native Temporal when present, or the pinned Temporal
  polyfill in `third_party/temporal`. The regeneration script, lockfile,
  and both dependency licenses are checked in. The Intl shim now emits era
  parts, which the polyfill needs to format UTC instants.

The new `data-formats` and `glob-apis` fixtures cover these paths. Their
expected output was generated with installed native Bun 1.4.2, with its exit
status checked separately. The native smoke run and all wasm engines pass.

## Verification

All 65 fixtures pass on each of QuickJS, browser, and JSC. `scripts/test-web.sh`
passes type checking, six web unit tests, the CLI network checks, Chromium,
and WebKit. All Cargo builds use six jobs inside a 4 GiB systemd scope, with
private target directories. Rebuilding the locked Temporal bundle produces
identical bytes.

The comparison uses the unchanged suite runner, launcher, dependencies, test
selection, and per-test timeout. The primary before and after runs use the
original 15-second file limit. A separate 60-second run lets the JSONL stress
file finish. Detailed results and artifact hashes are retained at
`/work/tmp/bun-wasm-parsers-glob-evidence/`.

| Matched 15-second runs | Before | After |
|---|---:|---:|
| Selected files | 25 | 25 |
| Fully passing files | 0 | 8 |
| Observed passing tests | 137 | 4,314 |
| Observed failing tests | 528 | 794 |
| Todos | 0 | 17 |
| Collection errors | 12 | 1 |
| File timeouts | 0 | 1 |

Only the wasm hash differs between these two runs' provenance records.
More assertions register after the API imports succeed, so the number of
observed failures can rise while thousands of additional tests pass.
The 60-second after run records 4,433 passes, 794 failures, 17 todos, eight
fully passing files, and no timeouts. Its extra passes are in the JSONL stress
file. The original before record is `before.json`, the matched after record
is `after-matched.json`, and the longer after record is `after-final.json`.

The completed focused runs include:

| File group | Passing tests |
|---|---:|
| TOML conformance | 708 / 708 |
| YAML conformance | 402 / 402 |
| YAML block scalar matrix | 1,084 / 1,084 |
| JSON5 conformance | 113 / 113 |
| JSONC differential fuzz | 6 / 6 |
| Node fs glob | 34 / 34 |
| JSONL, 60-second file limit | 312 / 315 |

The three JSONL failures are two allocations of 4 GiB, which wasm32 cannot
represent, and a 50,000-level nested value. Recursive Bun parser inputs are
bounded to 256 bracket levels before entering Rust because wasm's engine
call stack can overflow before Bun's linear-memory stack check. Parsed graph
materialization also limits depth to 4,096. A deep input throws a catchable
`RangeError` instead of trapping the instance. Ordinary JSONL parsing and
stream progress remain iterative in JS.

Run the original selection from this worktree:

```sh
source env.sh
scripts/bun-suite.sh --jobs 2 --timeout 15 \
  --launcher /work/tmp/bun-wasm-target/release/bun-wasm \
  --dependencies /work/projects/bun-wasm/docs/bun-test-suite/dependencies/node_modules \
  --output /work/tmp/bun-wasm-parsers-glob-recheck.json \
  'js/bun/glob' 'js/node/fs/glob.test.ts' 'js/bun/toml' 'js/bun/yaml' \
  'js/bun/json5' 'js/bun/jsonc' 'js/bun/jsonl' 'js/bun/resolve/toml' \
  'js/bun/resolve/yaml' 'js/bun/resolve/json5' 'js/bun/resolve/jsonc.test.ts' \
  'regression/issue/yaml-parse-syntax-error.test.ts'
scripts/test.sh --no-build
scripts/test.sh --no-build --engine browser
scripts/test.sh --no-build --engine jsc
scripts/test-web.sh
```

## Remaining upstream blockers

- `js/bun/glob/match.test.ts` reaches 496 passing tests. Its first failures
  call the missing `expect(...).toBeTrue()` helper. Other missing snapshot
  matchers account for most failures in `js/bun/yaml/yaml.test.ts`, which
  reaches 587 passes. These helpers were left to the test-runner work.
- `js/bun/glob/proto.test.ts:12` fails in `path.join` before scanning because
  the shared harness supplies a boxed String. The Node glob adapter accepts
  boxed `cwd` values itself, but the unrelated path boundary still rejects
  them.
- The baseline dependencies lack `fast-glob`, so `scan.test.ts` stops at
  import. A separate run installed its pinned version, 3.3.3, in disposable
  dependencies. It then stopped at `Bun.unsafe.gcAggressionLevel`, which the
  runtime honestly refuses. No upstream test or GC stub was changed.
- Subprocess checks remain blocked by `Bun.spawn`. Representative files are
  `glob/leak.test.ts`, `glob/path-length.test.ts`, JSON5 parser isolation
  tests, and TOML robustness tests.
- Two TOML stringify tests use Europe/Berlin time-zone data. The QuickJS
  Intl shim lacks that data, so the Temporal polyfill cannot give their
  native results. TOML's own four literal date/time types, including numeric
  offsets and nanosecond precision, pass the conformance corpus.
- Import attributes that request a loader different from the extension
  still use the runtime's existing import behavior. The matching `.toml`,
  `.yaml`, `.yml`, `.json5`, and `.jsonc` extensions work.
- `resolve/toml/crash/toml-crash.test.ts` calls `Bun.build` and needs a
  structured diagnostic position. `Bun.build` currently supplies no
  `position.lineText` for that case. This is a build-diagnostic gap.
- `regression/issue/yaml-parse-syntax-error.test.ts` passes its YAML checks,
  then compares the engine's ordinary `JSON.parse` error wording. QuickJS
  does not use native Bun's `JSON Parse error` prefix.

## Cleanup ownership

The task removes its three private Cargo target directories, temporary npm
installation, generated `web/dist`, and temporary dependency symlink after
verification. Test and browser servers exit through the existing scripts'
cleanup paths. The suite runner removes its execution copies and process
groups. Shared caches, the existing native launcher, and owner services remain.

The coordinator owns the retained worktree, its rebuilt `dist/*.wasm`, and the
small evidence directory until review and integration finish, then removes
them. The `vendor/bun` symlink points to the existing pinned checkout.
