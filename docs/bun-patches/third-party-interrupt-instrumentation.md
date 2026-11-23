## Third-party interrupt instrumentation

**Class: Host feature (original adapter).** `waffle/interrupt/rewriter.ts`, `loader.ts` and
`check.ts` are original TypeScript source, following a binary-format prototype.
The production implementation replaces the prototype's unconditional function-entry host calls
and per-activation loop sampling with one private module-global countdown shared by function
entries and loop headers. It adds native pre/post validation, an explicit supported-feature
allowlist, metadata refusal, a SHA-256 compiled-module cache and fatal-outcome-only host checks.
Bun and the own shell remain cooperative programs and are not rewritten.

Conceptual prior art (no implementation copied): DFINITY's
[New WebAssembly instrumentation](https://medium.com/dfinity/new-webassembly-instrumentation-2c93631e5718)
checks its internal instruction counter at reentrant function/loop entries; paritytech's
[`wasm-instrument` gas metering](https://github.com/paritytech/wasm-instrument/tree/master/src/gas_metering)
and Filecoin's `fvm-wasm-instrument` use internal mutable globals to avoid expensive per-block
host calls. Our countdown counts cancellation checkpoints rather than instruction gas, does
not meter blocks, and traps only after the supervisor has selected signal death.

`waffle/tests/fixtures/interrupt-browser-loops.ts` adapts our own `loops.wat` into a
readable TypeScript binary generator, preserving its independent teardown-only rescue word.
`interrupt-browser-workload.ts` freezes our own `workload.c`/`workload.wasm`,
not third-party source. Source SHA-256:
`d3eebbef9920faf0d12f3d2220e0425b80a9fc71f1919206103b3277724ec74c`; binary SHA-256:
`08c117f62e1323401b32ad116c85eab45765a6cffedd68970547bbad462406c8`. It was compiled with wasi-sdk
clang 23.1.0 / LLVM `895aa2c896ada719451be2e3673c83da8ddf1141`, `-O2 -nostdlib`, a WASI
wasm32 target, exported memory and a 16 MiB maximum memory. Source comments preserve exact
flags. The benchmark optionally takes the retained spike rewriter as an external input; it is
bundled only into the disposable measurement app, never into the shipped runtime.

### Local copy of the browser fixtures

Waffle 0.0.147 (PR 607) stopped publishing `tests/` in the npm package, so the browser
interrupt gate can no longer bundle these fixtures from `@waffle-os/runtime`. bun-wasm keeps a
copy in `web/tests/fixtures/interrupt/`, taken from Waffle revision
`4151b800bf27e8211403d0da3e32358cd9fd4c9a` (`@waffle-os/runtime@0.0.147`):

| Upstream path (`packages/waffle/`) | Local file |
| --- | --- |
| `tests/interrupt-browser.ts` | `interrupt-browser.ts` |
| `tests/interrupt-browser-control.ts` | `interrupt-browser-control.ts` |
| `tests/interrupt-browser-benchmark.ts` | `interrupt-browser-benchmark.ts` |
| `tests/fixtures/interrupt-browser-worker.ts` | `interrupt-browser-worker.ts` |
| `tests/fixtures/interrupt-browser-loops.ts` | `interrupt-browser-loops.ts` |
| `tests/fixtures/interrupt-browser-workload.ts` | `interrupt-browser-workload.ts` |

`interrupt-browser.ts` moves its per-repetition shape and signal loops into
`cancelEveryShape()` to meet our three-level nesting limit; the cancellation order and results
are unchanged. The other changes are imports. Relative Waffle source imports (`../proc/*`, `../interrupt/*`,
`../../core/wasi`, `../../fs/memory`) became the package's public `waffle/*` exports, the two
inline `import("../../proc/*.js")` types became type imports, and the six files sit in one
directory, so `./fixtures/` prefixes were dropped. `web/scripts/ci-process-bundles.ts` bundles
`interrupt-browser.ts` and `interrupt-browser-worker.ts` from this directory.



## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Third-party interrupt instrumentation](#third-party-interrupt-instrumentation) | Host feature | Original TypeScript binary rewriter, content-addressed loader and rescued browser fixtures; module-internal countdowns avoid per-entry host calls. |

[Ledger scope and pinned revisions](scope.md).
