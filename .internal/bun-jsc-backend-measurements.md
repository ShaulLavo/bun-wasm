# Bun JSC backend: measurement and design history

Working notes moved out of `docs/bun-jsc-backend.md`. The public page keeps the current facts, numbers and the reproducing command. Dated measurements, the choice of first slice and the pre-change baselines live here.

## Why semver is the first slice

Bun's Rust runtime depends on `bun_semver_jsc` alongside `bun_sys_jsc`,
`bun_http_jsc`, and the other engine-facing crates. Its semver module makes a small,
useful first test of the host-function boundary. It reads a call frame, converts
strings, raises errors, returns values, and builds a function table. It needs no
sockets, native threads, async callbacks, or platform-specific filesystem state.
The upstream semver suite also has a seeded differential comparison with node-semver.

The alternatives are much larger than their names suggest. `node_fs.rs` has 10,116
lines, its binding module has another 527, and it depends on `VirtualMachine`,
async filesystem tasks, argument parsers, and return-value adapters. `Blob.rs` has
6,820 lines and owns streams, stores, generated classes, and ref-counted lifetimes.
Even the 207-line HTTP header adapter depends on JSC's `FetchHeaders` class.
Starting with these would test several unported systems at once.

Our old semver bridge already called Bun's real parser. This change additionally
uses Bun's real argument checks, parsing branches, error formatting, and result
selection. It does not newly port the semver algorithm.


## Earlier compiler spike

An earlier spike on compiling Bun's real runtime found 23 prerequisite
compiler errors before either `bun_jsc` or `bun_runtime` type-checked. This spike
does not resolve those platform branches. It bypasses them by selecting a small
engine-facing source module with its own manifest. Large modules still need
both platform work and the missing value operations.


## Verification history

When this work was verified, the shared vendor checkout was missing already
committed Bun patch `0009`. All three initial full builds failed at
`dev_server/mod.rs:275` because `BundleV2::finish_wasi_dev_server` was absent.
Verification therefore used a private vendor worktree at the same pinned HEAD with
the existing patch applied. The semver source, tests, generated code, and
dependency inputs are unchanged, and no new vendor patch is introduced. The shared
checkout has since received patch `0009` (2026-10-16), so rebuilds from it need no
workaround.


## Size and gate results at the time

The optimized artifact sizes are:

| Artifact | Captured baseline bytes | Rebuilt bytes | Change |
| --- | ---: | ---: | ---: |
| `bun.wasm`, QuickJS | 10,859,284 | 10,867,162 | +7,878 |
| `bun-jsc.wasm` | 46,219,559 | 46,232,098 | +12,539 |
| `bun-browser.wasm` | 10,138,476 | 10,144,959 | +6,483 |

These are whole-artifact deltas against the captured pre-change binaries. They
include the facade, the intersection hook, the patch version bump, and resulting
link layout changes. The retained comparison results record the SHA256 of each
artifact. They do not isolate the size of each individual function.
No speed claim is made. Measure the string copies before using this design for
large buffers.

All required gates pass on this branch:

| Command | Result |
| --- | --- |
| `scripts/test.sh` | 89 passed, 0 failed |
| `scripts/test.sh --engine jsc` | 89 passed, 0 failed |
| `scripts/test.sh --engine browser` | 89 passed, 0 failed |
| `bash scripts/test-bun-jsc-backend.sh` | Two focused fixtures pass on every engine; inventory matches |
| `scripts/test-web.sh` | Type check, 16 unit tests, CLI networking, Chromium and WebKit checks pass |
| `cd site && bun install --frozen-lockfile && bun run build` | Pass |
| `node sandbox/tests/hmr-check.mjs <local site URL>` | All six browser/engine runs pass |

The targeted upstream selection is `cli/install/semver.test.ts` and
`regression/issue/08040.test.ts`, run through `scripts/bun-suite.sh` with
`--network loopback --jobs 1` and the pinned supplemental dependencies.
The suite revision, runner, dependency hashes, and 15-second file and 2-second
test limits match before and after.

| Engine | Before passing tests | After passing tests | After failing tests | Timeouts |
| --- | ---: | ---: | ---: | ---: |
| QuickJS | 1 | 346 | 5 | 0 |
| JSC | 1 | 346 | 5 | 0 |
| Browser host | 1 | 346 | 5 | 0 |

Before, the semver file fails to load because `semverIntersects` is missing.
The runner records that as one failure and one error, with no tests registered
from that file. After, it records 345 passing tests and five package-manager
failures there. The separate regression still contributes one passing test.
Fully passing files remain one of two. These are newly reachable passing cases,
not 345 independent bugs fixed by changing the parser.

The five remaining cases cover `--lockfile-only`, `bun pm version`, and the
diagnostic for an invalid range when the package exists. They fail on every
engine and were open when this was measured.


## Recommendation

Proceed module by module for host functions whose inputs and outputs are plain
data. Keep the source unchanged where possible and extend the facade only when
the next real module requires it. The unchanged semver bridge is a useful first
slice, and its internal intersection function removes a real upstream test blocker.

Do not attempt a wholesale replacement of `bun_jsc` over today's `Engine` trait.
The next design step is a rooted-value adapter with a host-engine
implementation and GC/reentrancy tests. Only after that works should this track
commit to async `node:fs` or `Bun.file`. Until then, track 1's JavaScript builtins
and bounded plain-data Rust modules give useful progress without pretending the
JSC memory model is portable.
