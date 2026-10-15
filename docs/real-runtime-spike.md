# Compiling Bun's real runtime to WebAssembly

## Quick summary

A single-threaded version of Bun's real runtime looks feasible, but it needs a substantial port. It cannot replace our runtime by changing a Cargo dependency. Bun's Rust and C++ bridge assumes a 64-bit machine, while our WebAssembly JavaScriptCore uses a different value representation. That is the first problem to solve.

Bun's code generation works. Its pinned BoringSSL also builds and runs basic crypto and TLS setup in wasm. The remaining work includes the value bridge, platform branches, disabled engine features, and adapting Bun's event loop and sockets to our host. Full native Bun behavior, especially shared-memory workers, is outside plain single-threaded WASI's capabilities.

My recommendation is to attempt one bounded milestone: the real Bun global object and module loader executing `console.log`, with allocation and garbage-collection stress tests. Do not commit to replacing the current runtime until that milestone works. The estimates below are engineering estimates, not measured implementation time.

## What this spike measured

The experiment uses bun-wasm `8fc2d8c` and pinned Bun `4ceda2c2868d3a7703c7737ddd9de7244ec384df`. WebKit is Bun's pin `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`, with our existing WASI patch and `USE_BUN_JSC_ADDITIONS=ON`. The existing build uses C_LOOP, no JIT, no JavaScript WebAssembly engine, no inspector or sampling profiler, system malloc, and ICU 78.3.

All work ran in an isolated worktree. No existing runtime, upstream test, Bun patch, JSC build, or distributed wasm artifact was changed. Scratch probes generated or compiled real sources. They did not link a real Bun executable.

Tools were Bun 1.4.2, wasi-sdk Clang 23.1.0, Rust nightly 1.100.0 `574ff7d98`, wasmtime 49.0.3, and Binaryen 133. Cargo ran under a 4 GiB scope with six jobs. C++ ran under a 5 GiB scope with six jobs. These scopes limit the guest build processes, not the owner's services.

Small raw logs, compiler commands, JSON diagnostics, suite results, and extracted ABI reproducers are retained at `/work/reports/bun-wasm-realrt/`. The committed probe runners reproduce the measurements once the listed pinned inputs and existing JSC build are present. Counts below distinguish errors in repeated headers from distinct source diagnostics.

## Code generation works before a runtime port

`jsc/real-runtime-probe.py codegen` invokes Bun's real `scripts/build.ts --mode=codegen`. The 49-step Ninja graph completed. It generated bindings, class wrappers, stream sinks, builtin functions, module sources, lookup tables, and Rust declarations. The class generator reported 94 classes, 80 resolved classes, and 1,547 exported symbols. The sink generator reported seven sinks and 91 symbols. Builtin bundling produced 198 internal modules, 13 native modules, and 50 internal functions in 16 files, about 2.8 MB of JavaScript.

The important outputs include `cpp.rs`, `generated_classes.rs`, `generated_js2native.rs`, `generated_jssink.rs`, `generated_host_exports.rs`, `ZigGeneratedClasses.cpp`, `JSSink.cpp`, and `WebCoreJSBuiltins.cpp`. Codegen occupied about 24 MiB. It satisfies the runtime crates' generated-file existence checks.

This mode needs native Bun, esbuild from Bun's installed dependencies, Perl for lookup tables, and Ninja. It needs no target compiler, NASM, WebKit rebuild, or newly built Bun executable. Bun's `scripts/build/configure.ts:372` deliberately separates this mode from native dependency configuration.

There is no supported `wasm32` configure target. The successful codegen uses the supported host target defaults. `scripts/build/codegen.ts:93` maps targets only to native platform and architecture strings. Generated JavaScript therefore needs an explicit WASI target policy before it can ship. The generated Rust build options mostly use `cfg!` expressions and do respect Cargo's actual target. One wrong WASI default is `ENABLE_TINYCC`, which remains true outside Android and FreeBSD.

A full native configure was probed separately. With `env.sh` loaded, it first required NASM for the x64 JPEG dependency graph. This is a native configure prerequisite, not a wasm codegen prerequisite. NASM 3.02 was installed from its official source under `/work/cache/wasm-tools/nasm`, about 6.5 MiB. Adding its `bin` directory to PATH made configure succeed in 2.2 seconds: 23 dependencies, 146 codegen outputs, and 1,220 native object edges. No native compilation followed. This graph targets Linux x64, so it is evidence that configuration works, not a wasm runtime build. The source archive SHA256 and build log are in `nasm-install.md` in the evidence directory.

## The C++ bridge does not compile unchanged

The probe takes the actual flags from JSC's `compile_commands.json`, as `crates/bunwasm-jsc/build.rs` already does for our helper. It adds Bun's source and generated-header directories. `USE_BUN_MIMALLOC=0` matches the existing system-malloc JSC build. This does not remove Bun's direct `mi_*` calls; allocator integration remains work for the final link.

The initial representative compilations found these concrete errors:

| Real source | Observed blocker |
| --- | --- |
| `src/jsc/bindings/ZigGlobalObject.cpp` | Three mirrored 64-bit layout assertions, plus unguarded `JSC::Wasm::StreamingCompiler` use with JavaScript WebAssembly disabled |
| `src/jsc/bindings/BunString.cpp` | The same shared layout assertions, followed initially by missing allocator headers |
| `src/jsc/bindings/JSBuffer.cpp` | Shared layout assertions and `JSBigInt::Digit` assumed to be `uint64_t`; wasm32 JSC uses a 32-bit digit |
| `src/jsc/bindings/ProcessBindingConstants.cpp` | Shared layout assertions after pinned compression headers and the native PCH prelude are supplied |
| `src/jsc/bindings/ProcessBindingFs.cpp`, `ProcessBindingBuffer.cpp`, `src/jsc/modules/NodeVM.cpp` | Shared mirrored layout assertions |
| `src/jsc/bindings/DOMURL.cpp`, `webcrypto/CryptoAlgorithmAES_CBC.cpp` | Object compilation succeeds without source patches |
| `src/jsc/bindings/webcore/JSEvent.cpp` | Three shared layout assertions |

`headers-handwritten.h:121,155,184` asserts native sizes and offsets for `ErrorableString`, `ResolvedSource`, and `ErrorableResolvedSource`. On wasm32 these structures have smaller pointers. Both C++ and Rust declarations must agree on the new layout. Deleting the assertions would hide the problem.

The whole-set probe uses Bun's generated `cxx-sources.txt` plus nine generated C++ files, 594 translation units in total. It runs actual object compilation through `ninja -k0 -j6`, rather than stopping at the first source. This is the upstream globbed set, including platform-only files that may compile to empty objects. It is not 594 independently useful runtime components.

Native Bun normally force-includes `root-pch.h`. That shared precompiled header would fail before most files were attempted. This diagnostic build instead force-includes only `root.h` and compiles every source separately, exposing errors beyond the shared header. It does not claim to reproduce the unmodified native build graph, and some uncategorized errors can still be missing implicit includes.

The first pass also exposes incomplete build setup. Native dependency headers are not all present in a fresh worktree. A second pass supplies pinned BoringSSL, mimalloc, Node, Highway, HdrHistogram, libdeflate, zlib, Brotli, and SQLite headers. Setup failures stay separate from porting failures. No fake POSIX headers or successful-source patches are used to make the port look healthier.

The corrected census compiles **133/594 objects** and fails **461/594**, with **1,823 error diagnostics at 239 distinct source-location and message pairs**. All failed commands exit 1; there are no compiler kills or OOM exits. The common three mirrored-layout assertions each appear in 438 translation units. Counts are not independent bugs.

The last setup failure was a missing pinned zstd header in `ProcessBindingConstants.cpp`. That unit was rerun with zstd and the normal `root-pch.h` prelude, after the WASI shim. Its remaining errors are the three shared layout assertions. The table includes that targeted rerun. No final diagnostic is a missing third-party header.

| Diagnostic family | All occurrences | Distinct diagnostics | Examples |
| --- | ---: | ---: | --- |
| 32-bit ABI and layout | 1,447 | 31 | Mirrored structs, Buffer BigInt digits, V8 shim layouts, StrongRef pointer packing |
| Platform branches and POSIX | 120 | 10 | V8 architecture selection, `netdb.h`, `spawn.h`, `termios.h` |
| Disabled JIT or JavaScript WebAssembly | 47 | 37 | Streaming compiler declarations and global-method-table callbacks |
| Disabled inspector or profiler | 54 | 54 | Inspector controller and sampling profiler members |
| Threads and allocator atomics | 21 | 3 | Bun's pinned mimalloc header lacks its fence aliases on this target |
| JSC declaration/type differences | 9 | 9 | Remaining value/API signature errors |
| Signals | 0 | 0 | The existing forced WASI shim supplies inert signal declarations; zero is not runtime signal support |
| Other and cascades | 125 | 95 | C++ library internals, consequent type errors, unsupported declarations |
| **Total** | **1,823** | **239** | |

The script assigns these families using explicit message/path rules. They are a reproducible triage, not a proof of root cause for every diagnostic. Its JSON retains the full messages for reclassification. The 95 uncategorized distinct diagnostics remain port-investigation work.

Across the 133 successful objects, the export audit finds 216 distinct mangled JSC/WTF references and **zero missing definitions** in those objects and the JSC/WTF/bmalloc archives. This excludes blocked translation units, C API names, Bun/Rust callbacks, and other native libraries. It is not a complete-link result.

A source diagnostic count is a lower bound. Clang stops after 30 errors per translation unit, missing includes stop parsing, and one unsupported API creates cascades. A zero in a category means no observed diagnostic, not that the corresponding subsystem is ported.

### JSC declarations and exports are different checks

The pins match, so there is no evidence of an arbitrary WebKit version mismatch. Some declarations disappear because our JSC configuration disables their feature. Bun must guard those consumers or provide a deliberate non-JIT implementation. DOMJIT fast paths, executable-memory FFI, inspector hooks, sampling profiling, and JavaScript WebAssembly support cannot be assumed available merely because the headers come from Bun's fork.

Compiler failures do not prove a missing link export. The probe separately compares undefined JSC/WTF symbols in successful objects against the existing static archives. The 216-reference result is recorded with the C++ results above. A complete Bun link is still required to discover unresolved symbols from the blocked files.

## The Rust check stops at prerequisite crates

The outer bun-wasm workspace does not include `bun_jsc` or `bun_runtime` in its selected dependency graph. Selecting them there fails package discovery. `scripts/real-runtime-rust-check.sh` instead uses Bun's own workspace manifest and explicitly applies our patched libc from `third_party/libc`.

With completed codegen, the combined check of both packages runs with `--target wasm32-wasip1 --keep-going`. It emits 185 compiler-artifact records across 170 unique packages and exits 101 with 23 compiler error diagnostics in three crates. Shared crates including `bun_core`, `bun_event_loop`, `bun_threading`, and `bun_uws` type-check. This does not link their C libraries or test their behavior.

| First blocker | Diagnostics | Exact source evidence |
| --- | ---: | --- |
| DNS and socket declarations absent from libc | 4 | `src/dns/lib.rs:19,47,52,57`: `sockaddr_un`, `AI_V4MAPPED`, `AI_ADDRCONFIG`, `AI_ALL` |
| Spawn platform selection and consequent missing types | 14 | `src/spawn/lib.rs:45`, `src/spawn/process.rs`: missing `Poller`, `SpawnOptions`, `SpawnProcessResult`, and `SpawnOptionsStdio`; a `not(unix)` branch chooses a Windows helper |
| Spawn return paths absent for WASI | 2 | `src/spawn/process.rs:460,2963` |
| Ctrl+C signal branches absent for WASI | 2 | `src/spawn/ctrl_c.rs:94,104` |
| Assumed 64-bit semantic-analyzer layout | 1 | `src/sema/types.rs:285`, `size_of::<TypeArguments<'static>>() == 16` |

Most spawn errors come from one missing platform implementation. They are not 18 separate subsystems. Adding the DNS constants would address compilation only, not implement DNS or Unix sockets.

Neither `bun_jsc` nor `bun_runtime` reaches library compilation. These are first blockers, not a count of all Rust work remaining. The final wrapper rerun reproduces the same 23 errors.

### The value representation is the highest-priority blocker

An independent extracted-source probe proves a deeper problem hidden behind those dependencies:

- `src/jsc/JSValue.rs:31` stores `EncodedJSValue` in `usize`, then asserts it occupies eight bytes. A wasm32 `usize` occupies four bytes.
- `src/jsc/DecodedJSValue.rs:45` explicitly asserts a 64-bit `usize`.
- `JSValue.rs:221,234` uses `usize` masks `0xfffe_0000_0000_0002` and `0xfffe_0000_0000_0000`. The wasm32 compiler rejects both as overflowing literals.
- Null, undefined, booleans, cell pointers, numbers, and the `1 << 49` double offset use JSValue64 encoding. Our JSC uses `JSVALUE32_64`, a different tag and payload encoding.

There is a separate GC-root handle problem. `src/jsc/Strong.rs:159-179` masks a pointer with `(1usize << 48)-1`. The C++ partner, `bindings/StrongRef.cpp:27-49`, packs a slot index into the top 16 pointer bits and asserts eight-byte pointers. A wasm32 pointer cannot carry that handle. Phase 1 must change the handle representation on both sides and test long-lived roots, destruction, and teardown. The first full C++ probe independently fails on this file's 48-bit shift and eight-byte pointer assertion.

The extracted probes fail with two layout assertions and two literal-overflow errors respectively. They are small independent reproductions, not a successful whole-crate check. Changing `usize` to `u64` alone is insufficient. Port the encoding, decoding, pointer conversions, generated host functions, and aggregate FFI calling conventions together. Otherwise a build can succeed while values are corrupted between Rust and C++.

## Networking has two replaceable layers

uSockets separates polling from socket operations. `packages/bun-usockets/src/internal/internal.h:54-64` selects `networking/bsd.h` separately from epoll/kqueue or libuv. `libusockets.h:618-642` exposes poll create/start/change/stop and fd access. The common ready-event dispatch is in `src/eventing/epoll_kqueue.c:257`.

That is a useful place to add a WASI backend, but replacing epoll alone does not work. `internal/networking/bsd.h:196-252` and `src/bsd.c` directly create, accept, connect, read, and write BSD sockets. They also expose UDP and Unix sockets. Host ABI handles are not operating-system file descriptors.

Our [host ABI](host-abi.md) already supplies nonblocking TCP listen, accept, connect, read, write, addresses, and blocking poll. A first adapter can preserve uSockets/uWS HTTP and WebSocket parsing above those two layers. It must maintain handle ownership and buffered readiness. The ABI's poll does not return a readiness list, so the adapter must scan registered handles and stage operations, or the ABI must grow a readiness result. Writable callbacks need backpressure handling to avoid spinning.

The current ABI lacks half-close, socket options, UDP, Unix sockets, descriptor passing, dedicated DNS results, and filesystem watch events. Full Bun socket parity needs additional host operations or explicit unsupported results. Plain WASI cannot provide them by adding libc declarations.

Browser hosts have a separate limit. Their TCP connect only reaches guest listeners. Arbitrary outbound browser traffic must use host fetch or a proxy. Host fetch bypasses Bun's real HTTP and TLS implementation and returns decoded response bodies. A real guest TLS stack does not remove browser networking restrictions.

## BoringSSL is a successful compilation experiment

The exact oven-sh BoringSSL pin is `41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f`. It recognizes `__wasm32__`. Its generic random backend chooses `getentropy`, which wasi-libc implements through `random_get`.

The first no-assembly, single-threaded build compiles 281 of 283 translation units. Two socket BIO units fail with three diagnostics: missing `SO_KEEPALIVE`, `connect`, and `netdb.h`. Adding supported `OPENSSL_NO_SOCK` resolves those errors without source patches. All 285 Ninja steps then pass, including the two archive steps. The output archives are 13,858,376 bytes for crypto and 5,873,152 bytes for SSL.

The supported no-thread macro is named `OPENSSL_NO_THREADS_CORRUPT_MEMORY_AND_LEAK_SECRETS_IF_THREADED`. It is suitable only for the proposed single-thread guest. A future shared-memory build must enable proper locking.

A linked wasm executable computes SHA256 of `abc`, obtains random bytes, and creates and frees an `SSL_CTX`. wasmtime prints:

```text
ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad rand=ok ssl_ctx=ok
```

That executable is about 9.6 MiB before final stripping. This proves static linking and execution of those operations. It does not prove a TLS handshake, certificate validation, or Bun's complete crypto integration. uSockets already uses custom BIO callbacks in `src/crypto/openssl.c:546`, so disabling BoringSSL's built-in socket BIOs fits the proposed byte-stream adapter.

## Some threads can become tasks; others cannot run inline

| Component | Source evidence | Plain wasip1 approach |
| --- | --- | --- |
| Finite task pool | `src/threading/ThreadPool.rs:700-737` | Existing patch drains finite jobs inline. New callers still need ordering and reentrancy tests. |
| HTTP client thread | `src/http/HTTPThread.rs:1215-1230,1338-1362` | Entry unconditionally spawns and runs forever. Factor a finite HTTP turn into the main event loop. Calling the thread entry inline would never return. |
| I/O watcher thread | `src/io/lib.rs:888-892,959-977` | Add a WASI I/O backend. Native branches select epoll or kqueue and panic elsewhere. |
| Async filesystem jobs | `src/runtime/node/node_fs.rs:1728,2436,2475` | Synchronous file work with deferred JS completion is plausible. Large operations will block JS. Audit completion ownership before reuse. |
| Web and Node workers | `src/jsc/web_worker.rs:476-492,620,953` | Existing implementation needs real concurrent threads and separate VMs. Inline execution loses parent progress, termination, and `Atomics.wait` behavior. |
| File watching | `src/runtime/node/path_watcher.rs:732,1394` | Requires host watch support or an explicit unsupported result. |
| Memory-pressure monitor | `src/runtime/node/memory_pressure.rs:457` | Replace OS monitoring with a wasm budget check, or disable this helper deliberately. |
| JSC GC helpers | Existing JSC build, `jsc/README.md` | Synchronous GC already works without concurrent or parallel collection. |

For workers with Bun's existing shared-memory semantics, `wasm32-wasip1-threads` is the relevant direction. It requires shared linear memory, atomics, thread startup, a matching libc, a rebuilt JSC, and host support. Browser shared memory also requires cross-origin isolation. Changing the Rust target name alone supplies none of the missing OS backends. Isolated wasm instances could implement a smaller message-passing worker product, but that would be a different implementation, not Bun's thread entry running inline.

## Size, memory, and garbage collection

Measured distributed artifacts are 46,219,559 bytes for `bun-jsc.wasm`, 10,859,284 for QuickJS, and 10,138,476 for the host-engine build. The JSC artifact is 44.1 MiB, or 12.3 MiB with gzip level nine. This updates the older approximately 43 MB figure in the JSC notes. The JSC, WTF, and bmalloc archives total about 33 MiB. BoringSSL's successful archives total 18.8 MiB. Codegen bundles about 2.8 MB of builtins.

A planning allowance for a minimal real-runtime build is 55-90 MiB uncompressed. A broad CLI with install, crypto, compression, databases, and additional native dependencies could reach 80-140 MiB. These are low-confidence estimates, not linked-binary measurements. The estimate starts with the existing 44.1 MiB JSC application, adds guest TLS and larger real runtime bindings, and allows for pointer-spill growth and removal of our current runtime. Archive sizes cannot be added directly because linking removes unused functions. Native executable size is not a reliable wasm predictor. Phase 1 must replace these estimates with a section-size and gzip report. This spike does not benchmark a real-runtime executable. Startup, TS/module loading, and GC-stress throughput against the current runtime must also gate phase 1; interpreter-only execution and no-assembly crypto can materially affect usefulness.

The 512 MiB maximum remains a practical constraint. `crates/bunwasm-cli/build.rs:10` reserves the top three address bits for Bun's string tags; the launcher also caps guest memory. Both real Bun heaps, ICU data, builtins, TLS buffers, the native stack, and allocator metadata share that budget. File size is not heap consumption, though static data consumes linear memory. The existing JSC notes report fragmentation and abort-on-GC-exhaustion behavior. This spike has not measured the real runtime's idle or peak heap.

Every complete binary containing JSC must go through `wasm-opt --spill-pointers`, including the new C++ and Rust bindings. JSC conservatively scans linear-memory stack slots, while wasm locals otherwise sit outside that scan. The existing JSC experiment measured roughly 50% code growth for the shell and 5-15% runtime cost. These are prior JSC measurements, not new real-runtime measurements.

The spill pass can cover newly linked functions, but compilation is no proof of GC correctness. Phase 1 must exercise unprotected temporary values across allocating callbacks, Rust-to-C++ calls, exceptions, module loading, promises, and repeated forced collection after the final pass. Long-lived native references still require JSC barriers or protected handles. Spilling does not turn arbitrary native storage into a GC root. Our current JSC notes also record VM teardown aborting in `AtomStringImpl::remove`; adopting the real global object does not establish that this is fixed.

## Verdict and execution plan

A port that uses Bun's actual global object, builtins, loader, filesystem, and HTTP code is technically plausible. The successful codegen, existing C-loop JSC, and executed BoringSSL build remove three major unknowns. The hard unproven step is a correct 32-bit Rust/C++/JSC bridge. Until that links and survives GC stress, feasibility remains an engineering judgment rather than a running real-runtime demonstration.

Exact native Bun parity on unextended, single-threaded wasip1 is not feasible. Native addons, generated machine code, ordinary subprocesses, signals, shared-memory workers, and OS watchers require unavailable facilities or additional host implementations. Bun FFI must be explicitly excluded initially: `src/runtime/ffi/FFI.h:6-13` selects JSValue64 only, and `FFIObject.rs:876-880` assumes 56 address bits. Runtime generation of native machine code cannot run in wasm linear memory. Install cannot promise general lifecycle-script compatibility either: the current subprocess ABI only launches another bun wasm instance, not arbitrary native tools or shells. External lifecycle commands and native build helpers stay excluded unless the host contract changes. This conclusion does not prevent using the real runtime for the supported subset.

Plan status: Approved. Implementation is separate from this research spike. Estimates assume one engineer familiar with Rust, JSC internals, and this repository. They are elapsed engineering effort with review and tests, not promises.

| Phase | Deliverable and completion proof | Estimate |
| --- | --- | --- |
| 0 | A real wasm target in Bun's configure/codegen; reproducible dependency and runtime check graph; feature exclusions named explicitly | 3-5 days |
| 1 | Port split-tag values, StrongRef handles, and mirrored layouts; gate unavailable engine APIs; link the real Bun global object and module loader; run `console.log` and a multi-module TS program after pointer spilling; stress FFI values and GC | 3-6 weeks |
| 2 | Real `node:fs`, `Bun.file`, Buffer, timers, and finite async filesystem jobs; upstream subset passes with WASI preopens and correct callback ordering | 1-3 weeks |
| 3 | Cooperative HTTP/I/O turn plus both uSockets adapters; guest TLS, fetch, TCP, HTTP server, and WebSocket interoperability under the native launcher | 3-6 weeks, low confidence |
| 4 | Expand builtins, crypto, streams, bun:test, restricted install, and CLI behavior; measure bundle size and heap; rerun the full upstream compatibility census | Preliminary 2-6 weeks for a selected subset; re-estimate after phase 1 |
| 5 | Optional shared-memory target and workers; rebuild all relevant libraries and validate browser and native host support | 3-6 additional weeks, higher uncertainty |

Budget roughly 8-16 engineer-weeks for a useful subset through phase 3, conditional on phase 1 succeeding. That total excludes phases 4 and 5. Phase 4 needs a new scope and estimate after phase 1, and phase 5 is optional. Broad parity and a threaded browser product need separate estimates after phase 1.

Ranked blockers are:

1. Correct value representation and FFI layouts. A wrong fix can silently corrupt every JS value.
2. Single-thread scheduling and ownership. Infinite HTTP/I/O thread entries cannot reuse the finite ThreadPool patch.
3. Bun's unguarded use of disabled JSC features and 64-bit fast paths.
4. Complete link integration: native dependencies, allocator ownership, unsupported process/signal paths, and feature selection.
5. Memory and GC correctness under 512 MiB after whole-program pointer spilling.
6. Networking parity and browser restrictions beyond the current host ABI.

The stop condition for the next milestone is a bridge that cannot reliably pass value and GC stress within the memory cap. If that happens, reconsider a wasm64 target with a different browser/host support tradeoff, or retain our runtime with selected real Bun components. Do not spend weeks porting networking before proving the value bridge.

## Reproduce the probes

Run from an isolated bun-wasm worktree with its pinned Bun source and existing JSC build. `env.sh` must be sourced before commands. The Rust probe needs Bun's gitignored `vendor/lolhtml` and `vendor/rust-argon2` sources present. Neither script fetches every dependency automatically. The TLS script requires the caller to supply source from the stated BoringSSL commit; it does not authenticate an arbitrary source directory. The spike downloaded the archive URL for that exact commit.

```sh
source env.sh
systemd-run --user --scope -p MemoryMax=4G nice -n 5 \
  python3 jsc/real-runtime-probe.py codegen \
  --output /work/tmp/bun-wasm-realrt-codegen
BUN_CODEGEN_DIR=/work/tmp/bun-wasm-realrt-codegen/codegen \
  scripts/real-runtime-rust-check.sh /work/reports/bun-wasm-realrt/rust-vendor
scripts/real-runtime-network-tls.sh "$BORINGSSL_SOURCE" "$BORINGSSL_BUILD"
```

For C++, use `python3 jsc/real-runtime-probe.py cpp --help`, a fresh output directory, and the pinned header roots listed in the evidence manifest. Put BoringSSL before Node's bundled OpenSSL headers. The script uses real object compilation, preserves each compiler command and diagnostics, and writes `summary.json` and `diagnostics.json`. Run it inside the 5 GiB cage with at most six jobs.

## Verification and retained resources

All tests use the copied prebuilt artifacts. No Rust runtime changed, so none of the three engines was rebuilt. Their SHA256 hashes still match the originals: QuickJS `3835b6656883d1d6252ad2b69f36a2f55750b927a5d8911cc4a4d32d9a46ece6`, JSC `a304e296ef481feaac97adca9a5f35567b8cbea710ddf5c8753c1d89a5da97b7`, browser `a8e0143572edc3bfd29179a10a3997d813c982b157c4f36a5b9d7c42d0ceb1b7`.

`scripts/test.sh --no-build` passes **86/86** fixtures on each of QuickJS, JSC, and browser. `scripts/test-web.sh` exits zero, including 16 unit tests, local registry/network checks, and Chromium/WebKit browser checks. Shell/Python syntax checks pass. The committed TLS runner builds its smoke executable, checks the known SHA256 digest, executes it under wasmtime, and removes it on exit.

The requested before/after upstream measurement uses unchanged files `js/node/buffer-concat.test.ts`, `js/node/console/console.test.ts`, and `js/web/html/URLSearchParams.test.ts`. Each run uses `scripts/bun-suite.sh --network loopback --jobs 2`, the 15-second file deadline, and the shared pinned suite as a read-only source. The runner creates and cleans its private snapshots. Supplemental test dependencies are absent in both runs. This is a small preservation measurement, not the checked-in full baseline.

| Existing engine | Files fully passing before → after | Observed passes before → after | Observed failures before → after | Timeouts before → after |
| --- | ---: | ---: | ---: | ---: |
| QuickJS | 0 → 0 of 3 | 12 → 12 | 13 → 13 | 0 → 0 |
| JSC | 0 → 0 of 3 | 9 → 9 | 17 → 17 | 0 → 0 |
| Browser | 0 → 0 of 3 | 7 → 7 | 16 → 16 | 1 → 1 |

Every run also reports one collection error. The browser timeout is in `buffer-concat.test.ts`. Passing fixture tests do not imply upstream-suite compatibility. Before/after provenance and summary records match exactly, as expected because no runtime artifact changed. The checked-in baseline documents were not regenerated.

Pinned header inputs for the C++ census are listed here so the local evidence directory is not the only copy of their identities. Sources come from these projects' archives at the stated commit. Bun's existing dependency patches are applied only in scratch.

| Input | Pin or source | Preparation beyond extraction |
| --- | --- | --- |
| BoringSSL | `oven-sh/boringssl` `41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f` | Use `include` before Node's bundled OpenSSL headers |
| mimalloc | `oven-sh/mimalloc` `92ef6587c57b262f6e6abf513f7776a2f8d12aeb` | Use `include` |
| Node headers | Node 26.3.0 release headers | Use `include` and `include/node` |
| Highway | `google/highway` `2607d3b5b0113992fe84d3848859eae13b3b52c1` | Bun's `silence-warnings.patch` and `sve2-requires-sve.patch` |
| HdrHistogram | `HdrHistogram/HdrHistogram_c` `18c7a324383dded1451d15621cd018b0048057d0` | Bun's `bitscan-type.patch` and `no-avx2-dispatch.patch`; use `include` |
| libdeflate | `ebiggers/libdeflate` `92e6a0db9fa848d742f9eb286c92afc60f2c3dda` | Use source root |
| zlib-ng | `zlib-ng/zlib-ng` `12731092979c6d07f42da27da673a9f6c7b13586` | Bun's `clang-cl-arm64.patch`; generate headers with non-Windows substitutions from `scripts/build/deps/zlib.ts:223-232` |
| Brotli | `google/brotli` `028fb5a23661f123017c060daa546b55cf4bde29` | Use `c/include` |
| zstd | `facebook/zstd` `f8745da6ff1ad1e7bab384bd1f9d742439278e99` | Use `lib`; final constants-unit rerun |
| SQLite | Bun's `src/jsc/bindings/sqlite/sqlite3_local.h`, version 3.53.4 | Copy unchanged to `sqlite3.h` |
| Dependency versions | Bun's successful native configure | Add the directory containing `bun_dependency_versions.h` |

The final host cleanup check finds no owned compiler, Cargo, Ninja, wasmtime, Bun, Node, launcher, or test-server process. No service, route, container, or mount was created. The 934 MiB Rust target, extracted-probe output, earlier C++ trees, download archives, temporary TLS executable, web output/dependencies, and generated native Cargo config were removed. Small first-pass evidence is compressed in the report directory.

The reusable inputs below remain intentionally. The coordinator owns removal after reviewing the spike or after the first implementation milestone consumes/replaces them. They have no running service consumer. All paths in this table start with `/work/tmp/bun-wasm-realrt-`.

| Retained suffix | Approximate disk use | Current consumer |
| --- | ---: | --- |
| `codegen` | 23 MiB | Generated runtime sources for the next bridge build |
| `tls-probe` | 295 MiB | Pinned TLS source, successful archives, and CMake build |
| `cpp-complete` | 24 MiB | Final commands, objects, and per-source diagnostics |
| `headers` and `extra-headers` | 103 MiB combined | Pinned inputs for the committed C++ runner |
| `configure-nasm` | 9.4 MiB | Native graph evidence and dependency-version header |

These scratch trees total about **455 MiB**. The requested worktree remains at `/work/worktrees/bun-wasm/real-runtime-spike`, about **457 MiB**, including its detached pinned Bun source and copied wasm artifacts. The installed NASM tool is **6.5 MiB** under `/work/cache/wasm-tools/nasm`; keep it while native Bun configuration needs it. Small evidence and the decision trail occupy about **3.1 MiB** in `/work/reports/bun-wasm-realrt/`. Pre-existing JSC/toolchain trees, shared caches, services, and upstream source are preserved.

Independent review used source, artifacts, and the decision trail; no transcript file was supplied. Requested review model: GPT-5.6 Sol; backend identity not independently verified. Its main remaining caution is that feasibility, size, and schedule stay conditional on the value/StrongRef bridge linking and surviving GC and performance tests. A real Bun runtime executable has not been produced by this spike.
