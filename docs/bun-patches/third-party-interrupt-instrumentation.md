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



## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Third-party interrupt instrumentation](#third-party-interrupt-instrumentation) | Host feature | Original TypeScript binary rewriter, content-addressed loader and rescued browser fixtures; module-internal countdowns avoid per-entry host calls. |

[Ledger scope and pinned revisions](scope.md).
