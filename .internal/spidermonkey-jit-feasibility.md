# SpiderMonkey-in-Wasm JIT feasibility

Research date: November 1, 2026. Source inspection only, for the Engines coordinator. This is a finding, not an implementation plan or execution grant.

## Verdict

**Substantial backend port and validation required.** Our pinned engine cannot gain browser JIT by enabling a flag. The HeyPuter lead is real: it implements JavaScript-to-Wasm compilation using Warp and a custom backend, then asks the outer browser to compile the generated modules. It is a useful experimental starting point, not upstream support or a drop-in WASI engine. A narrowly bounded proof is plausible without porting Firefox's browser UI. [1], [2], [3]

The distinction matters. The backend already exists in the fork, so this is not research from zero. Integrating it safely into our pinned standalone engine remains substantial work.

## What the source actually implements

The inspected `HeyPuter/firefox-wasm` default head is `bc69aaa5e2c5388bcf93a43b975b490bb940f4c0`, July 22, 2026. Its Makefile pins **another repository**, `HeyPuter/firefox`, at `2e1e835a5da5907e5ceef19aade58a7493f1e34d`, July 13. The important compiler code lives there, not in the wrapper repository. The June 21 rearchitecture commit is [`64e56d5d15384a70b467184c8dcae3712307e5f9`], [4]. I also checked the fork's newer default head, `f08e4aa189eb02015568aea1085dab77a187c330`, July 23, and its four-commit delta from the wrapper's pin. [1], [4], [5]

The executable call chain is concrete:

- `WasmJitWarp.cpp::WJWarpCompile` builds a `WarpOracle` snapshot from a real `JSScript`, runs `WarpBuilder` and `OptimizeMIR`, and calls `WJEmitBody`. `AssembleAndInstall` encodes a Wasm module importing `m.help`, the engine's own `m.mem`, and `m.tbl`. It calls `wasmhost_compile` and `wasmhost_instantiate`, then installs the compiled main function in the table. [2]
- `WasmJitBackend.cpp` emits Wasm instructions from optimized MIR. `WasmJitRuntime.cpp` handles warmup, argument transfer, VM helpers, GC roots, and returning to PBL after a guard fails. These three files alone contain 20,252 source lines at the wrapper's pin. That is source scope, not compiled size. [2], [6]
- The browser's actual bridge calls `new WebAssembly.Module(bytes)` and `new WebAssembly.Instance(module, imports)`. It imports the existing engine memory, supplies `_wjhelp`, creates a 4,096-entry function table, and installs exports with `table.set`. Emscripten `addFunction` also installs entry trampolines in the main indirect table. This is runtime module generation, not CPU emulation. [3]

There is a browser build, not merely a server experiment. `gecko.js/build-lib.sh` links this bridge with `ENVIRONMENT=web,worker`, exported helper functions, and growable tables. Separately, `bench/spidermonkey.js/build.sh` links `libjs_static.a` without `libxul` for Node. That standalone embedder is evidence that the compiler is separable from Firefox UI. The Node harness is **not browser execution evidence**, and neither build script proves present browser reliability. No artifact was run here. [7], [8]

## Four mechanisms that must not be conflated

1. **Native machine-code JIT.** Ordinary Baseline and Ion output native instructions. Wasm linear-memory bytes cannot become executable native code through a C function-pointer cast. WebAssembly has immutable compiled code and typed indirect calls. Even the `jit/wasm32` directory at our Mozilla pin contains crashing code-generation and entry-trampoline stubs, not an implemented optimizing Wasm backend. The same entry stubs remain at observed upstream main `e924f94175311819d7b549a732d0d8ee1263b31d`. [9], [10]
2. **PBL.** `PortableBaselineInterpret.cpp` executes bytecode and inline caches in C++, without native code generation. The outer browser may compile that C++-derived Wasm, but it is still interpreting the user's JavaScript. [11]
3. **Warp and MIR.** Warp is a JavaScript compiler front end. Pinned `Ion.cpp::CompileBackEnd` normally continues through MIR optimization, LIR, register allocation, and machine-code generation. The "WarpIR" lead refers here to the snapshot and CacheIR-to-MIR pipeline, not an executable Wasm format. Having Warp does not supply Wasm output. The fork adds that output path. [2], [12], [18]
4. **Generated Wasm modules.** The guest emits Wasm bytes and crosses a host API boundary to compile and instantiate them. Official module, instance, memory, and table APIs permit this arrangement. Passing the same memory to two instances does not require `SharedArrayBuffer`; the fork's module emitter handles both shared and non-shared memory. CSP can block compilation, and synchronous compilation costs still exist in a worker. [2], [3], [13]

The route therefore applies to browser workers in principle. It does not require Wasmtime or native execution privileges. A Wasmtime implementation would need its own compile, instantiate, memory, table, and reentrant helper bridge. Wasmtime compiling our outer guest alone does not JIT the JavaScript inside it. [2], [3], [13]

## Concrete gaps for our engine

- **Different build and host ABI.** Our experimental source at `1a53e2123e4876be671a9a03eb025ae569795001` targets `wasm32-wasip1`, with `--disable-jit`, PBL enabled, no Intl, and shared JS memory disabled. Its profile explicitly records `jit: false`. The fork uses Emscripten imports, exports, globals, and `__EMSCRIPTEN__`-guarded interpreter and GC hooks. Those need explicit WASI integration, host compilation imports, helper exports, shared-instance memory identity, and table ownership compatible with our relocated side module. Defining `__EMSCRIPTEN__` or removing `--disable-jit` is not that port. [3], [14]
- **Engine internals, not a stable library boundary.** Required changes include PBL warmup and call routing, `WasmJitResumeViaPBL`, Warp snapshot assumptions, VM helper dispatch, GC tracing for minor and major collections, and invalidation. The fork directly uses SpiderMonkey object layouts and script/frame state. Its July source and our pinned November source differ. These hooks need adaptation and semantic tests, not just copied compiler files. [6], [14]
- **A decisive missing control.** Both the wrapper-pinned backend at lines 10801-10803 and newer fork backend at lines 10823-10825 treat MIR `InterruptCheck` as `EffectKind::Skip`. This route does not preserve our interrupt contract as written. A port must emit a real interrupt poll and verify termination of compiled loops. Host stack guards do not provide that poll. [15]
- **GC and bailout reliability remain unproven.** Newer fork code adds traced script pointers and compile-time GC suppression. It also skips invalid or swept-looking root slots in `WJTraceValueRoot` and `WJTracePtrRoot`. Those filters are implemented, but the comments' soundness claims are not independent proof of correct root lifetimes. Recursion handling also changed after the wrapper pin. These are reasons to audit active roots, moving GC, side-effect-preserving resume, and stack limits before adoption. [5], [16]
- **Partial coverage and lifecycle.** The fork defaults to a 4,096-byte script limit, eight arguments, and a 4,096-slot compiled-call table. Unsupported MIR returns to PBL. Its generated exception-tag ABI is disabled by `kWJEHABI = false`. Module retention, table-slot reuse, multiple engine contexts, and teardown need explicit ownership. These limits do not make the approach impossible; they rule out treating it as complete Ion parity. [2], [6], [17]

## Smallest useful experiment and effort

A bounded later experiment could port only a pure numeric leaf-function path at our exact Mozilla pin. It would need real Warp input, a restricted MIR emitter, a worker-side compile/instantiate bridge, engine-memory and table wiring, a call entry, and guard failure back to PBL. Reject allocation, side effects, nested calls, and unsupported nodes before execution. Count an installed module and actual compiled calls, and prove a type-changing guard returns the interpreter result. Hand-emitting a constant module would prove only the host bridge.

Rough source-based sizing is **3 to 5 engineer-days for that restricted proof**, assuming familiarity with SpiderMonkey and no frontend build surprises. This is an estimate, not authorization. A trustworthy general port is **several engineer-weeks or more**, dominated by the named PBL/GC/resume changes, real interrupt checks, ABI adaptation, and cross-browser controls. Confidence in that larger range is low without attempting the port. No speedup, code-size delta, or browser coverage is established by this research.

## Acceptance and custody

The approved Unicode design remains separate. The no-Intl profile and reviewed ICU4X source corrections do not enable a JIT. `interp` and `pbl` name interpreter choices, not browser JIT tiers. **No native, browser, runtime, both-tier, G3 hello, or producer acceptance is granted or inferred.** The admitted public107 packet is unchanged.

Only this note and the small source-reference JSON are committed. The coordinator's external `main-account/RESULT.md` records the delivered head and tree. The JSON retains exact source URLs, revisions, byte counts, and SHA-256 values, not source archives. These files belong to this research lane and remain until folded into PR 455 or the coordinator discards them. No clone, checkout, build, browser session, background process, downloaded binary, or scratch directory was created. Retained G1/G2/G3 roots were read only.

## Primary sources

The anchors below use original source line numbers. The adjacent JSON records immutable source hashes.

[1]: https://github.com/HeyPuter/firefox-wasm/blob/bc69aaa5e2c5388bcf93a43b975b490bb940f4c0/Makefile#L26-L29
[2]: https://github.com/HeyPuter/firefox/blob/2e1e835a5da5907e5ceef19aade58a7493f1e34d/js/src/wasm/WasmJitWarp.cpp#L90-L306
[3]: https://github.com/HeyPuter/firefox-wasm/blob/bc69aaa5e2c5388bcf93a43b975b490bb940f4c0/gecko.js/lib/wasm-host-bridge.js#L30-L180
[4]: https://github.com/HeyPuter/firefox/commit/64e56d5d15384a70b467184c8dcae3712307e5f9
[5]: https://github.com/HeyPuter/firefox/compare/2e1e835a5da5907e5ceef19aade58a7493f1e34d...f08e4aa189eb02015568aea1085dab77a187c330
[6]: https://github.com/HeyPuter/firefox/blob/2e1e835a5da5907e5ceef19aade58a7493f1e34d/js/src/wasm/WasmJitRuntime.cpp#L650-L689
[7]: https://github.com/HeyPuter/firefox-wasm/blob/bc69aaa5e2c5388bcf93a43b975b490bb940f4c0/gecko.js/build-lib.sh#L86-L129
[8]: https://github.com/HeyPuter/firefox-wasm/blob/bc69aaa5e2c5388bcf93a43b975b490bb940f4c0/bench/spidermonkey.js/build.sh#L59-L74
[9]: https://webassembly.org/docs/security/
[10]: https://github.com/mozilla-firefox/firefox/blob/a5df22d986d4b626f771b4f8885241941601c35c/js/src/jit/wasm32/Trampoline-wasm32.cpp#L11-L41
[11]: https://github.com/mozilla-firefox/firefox/blob/a5df22d986d4b626f771b4f8885241941601c35c/js/src/vm/PortableBaselineInterpret.cpp#L5-L10
[12]: https://github.com/mozilla-firefox/firefox/blob/a5df22d986d4b626f771b4f8885241941601c35c/js/src/jit/Ion.cpp#L1743-L1769
[13]: https://webassembly.github.io/spec/js-api/index.html#the-webassembly-namespace
[14]: https://github.com/HeyPuter/firefox/blob/2e1e835a5da5907e5ceef19aade58a7493f1e34d/js/src/vm/PortableBaselineInterpret.cpp#L9650-L9740
[15]: https://github.com/HeyPuter/firefox/blob/f08e4aa189eb02015568aea1085dab77a187c330/js/src/wasm/WasmJitBackend.cpp#L10822-L10825
[16]: https://github.com/HeyPuter/firefox/blob/f08e4aa189eb02015568aea1085dab77a187c330/js/src/wasm/WasmJitRuntime.cpp#L5232-L5314
[18]: https://firefox-source-docs.mozilla.org/js/how-we-optimize.html
[17]: https://github.com/HeyPuter/firefox/blob/2e1e835a5da5907e5ceef19aade58a7493f1e34d/js/src/wasm/WasmJitBackend.h#L442-L455

Additional official API references: [module compilation and CSP](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Module/Module), [instance construction](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Instance/Instance), [memory imports](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Memory), and [table installation](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Table/set). The WebAssembly JS API link is the October 28, 2026 editor's draft, not a claim that every draft feature ships in browsers.

## Lite follow-up: executable path and the next proof

I rechecked the path at the wrapper's pinned fork and sampled the fork's current head `f08e4aa189eb02015568aea1085dab77a187c330`. The path is executable in source terms. `WJWarpCompile` enters the script realm, creates a `WarpOracle` snapshot, runs `WarpBuilder` and `OptimizeMIR`, then `AssembleAndInstall` emits the body, calls `wasmhost_compile`, calls `wasmhost_instantiate`, and installs the module's register-convention export in the shared table. A failed MIR emission, host validation, instantiation, or table install returns `-1`, leaving the function in PBL. This is implemented control flow, not evidence that our pinned engine can link it.

The bridge has two limits that a port cannot hide behind a feature flag. `wasmhost_instantiate` rebuilds imports from numeric ids and creates a host `WebAssembly.Instance`; `wasmhost_call` copies arguments through `Number` and returns a `Number`, and the bridge comments explicitly exclude i64 and reference arguments/results from the table-call path. The bridge keeps compiled modules in `globalThis.__whReg` and host objects in `__whObj`; the inspected file has no release or module-destroy operation. The prototype must therefore restrict its first ABI to f64 and prove memory/table identity, then measure or eliminate retained handles before claiming a usable lifecycle.

The fork's runtime work is broader than the emitter. `WasmJitObserveCall` and `WasmJitPreCall` gate by script shape and warmup, optionally queue `JSScript*` values for `WasmJitDrainDeferred`, and install a direct trampoline only after a successful compile. `WasmJitInvalidateAll` resets entries and clears cached callee pointers, but deliberately leaves an already-running JIT frame on its old module and does not release host handles or table slots. `WasmJitResumeViaPBL` reconstructs a PBL frame at a bytecode offset, seeds locals and the expression stack, and creates a fresh `JitActivation` for some entry paths. `WJTraceRoots` traces scratch values, deferred scripts, shape and property caches, call roots, and active deopt spills. Those functions show the intended contracts and the repair history. They do not prove moving-GC safety, exception semantics, or teardown in our `wasm32-wasip1` build.

One gap is explicit in the current backend: `EmitEffect` maps both `CheckOverRecursed` and `InterruptCheck` to `EffectKind::Skip`. `Bail`, `Throw`, and `Unreachable` instead emit a PBL deopt. The fork's register ABI also caps actual arguments at eight and leaves `kWJEHABI` false, so exception propagation uses the legacy return-flag path. A compiled loop that ignores the engine's interrupt state is a hard stop for a general runtime, even if a numeric leaf works.

The smallest useful sequence has two gates. A bridge smoke test can instantiate a hand-built f64 module against the guest memory and table, call it through the same import ids, and verify the result and memory identity. It only settles host ABI wiring. The first JIT proof must then use a real script at our exact SpiderMonkey pin, show `WJWarpCompile` success and a table-installed call, and compare several calls against PBL. Keep it to numeric MIR with no allocation, object access, helper call, inlining, or exception. Add one type guard that deopts and check that `WasmJitResumeViaPBL` resumes once without repeating a side effect. If that passes, a separate loop probe must show an interrupt reaches the loop and terminates it; the current `InterruptCheck` skip means this probe is expected to fail until a real poll exists.

Pass means all of those observations are recorded from the actual counters and return values: a generated module was host-compiled and instantiated, the shared table call returned the PBL-equivalent value, the guard fallback resumed exactly once, and a moving-GC/deopt stress run left no stale root or wrong result. The loop gate must terminate on an injected interrupt. Stop on any host compile rejection, memory-growth mismatch, table signature trap, duplicate side effect after deopt, stale or invalid GC root, ignored interrupt, unbounded recursion, or retained module/table growth with no bounded owner. No pass at this level says the engine is accepted or fast.

The cost order is clear. The bridge smoke is hours and has low decision value. The exact-pinned numeric Warp proof is roughly 3 to 5 engineer-days and can decide whether the lead is worth a deeper port. Adding moving-GC, deopt, interrupt, and lifecycle coverage is the substantial backend port, several engineer-weeks or more, with the fork's current code offering starting points but no acceptance evidence. The original verdict remains correct: this is a real experimental backend, not a switchable SpiderMonkey tier.

Follow-up primary-source anchors: the [fork front end](https://github.com/HeyPuter/firefox/blob/f08e4aa189eb02015568aea1085dab77a187c330/js/src/wasm/WasmJitWarp.cpp#L98-L301), [bridge call and table ABI](https://github.com/HeyPuter/firefox-wasm/blob/bc69aaa5e2c5388bcf93a43b975b490bb940f4c0/gecko.js/lib/wasm-host-bridge.js#L239-L307), [bridge JIT memory and table registration](https://github.com/HeyPuter/firefox-wasm/blob/bc69aaa5e2c5388bcf93a43b975b490bb940f4c0/gecko.js/lib/wasm-host-bridge.js#L390-L450), [runtime invalidation and warmup](https://github.com/HeyPuter/firefox/blob/f08e4aa189eb02015568aea1085dab77a187c330/js/src/wasm/WasmJitRuntime.cpp#L648-L749), [deferred drain](https://github.com/HeyPuter/firefox/blob/f08e4aa189eb02015568aea1085dab77a187c330/js/src/wasm/WasmJitRuntime.cpp#L1015-L1052), [root tracer](https://github.com/HeyPuter/firefox/blob/f08e4aa189eb02015568aea1085dab77a187c330/js/src/wasm/WasmJitRuntime.cpp#L5232-L5314), [backend ABI limits](https://github.com/HeyPuter/firefox/blob/2e1e835a5da5907e5ceef19aade58a7493f1e34d/js/src/wasm/WasmJitBackend.h#L429-L455), and [skipped interrupt effect](https://github.com/HeyPuter/firefox/blob/f08e4aa189eb02015568aea1085dab77a187c330/js/src/wasm/WasmJitBackend.cpp#L10822-L10825).
